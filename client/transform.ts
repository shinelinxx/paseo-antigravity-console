import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  ASK_QUESTION_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  type AskQuestionCard,
  type SubagentCard,
  type SubagentCheck,
} from "../shared/contracts";
import {
  extractToolOutput,
  firstNonEmptyLine,
  formatQuestionEcho,
  normalizeEchoText,
  parseAskQuestions,
} from "./questionModel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** agy logs live under `<home>/.gemini/antigravity-cli/brain/<conversation>/`. */
const AGY_LOG = /[/\\]brain[/\\][0-9a-f-]{36}[/\\]/i;
const MAX_ECHO_CACHE = 200;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function extractChildId(output: unknown): string {
  const text = extractToolOutput(output);
  if (text) return UUID_ANYWHERE.exec(text)?.[0] ?? "";
  if (output && typeof output === "object") {
    const id = (output as { conversationId?: unknown }).conversationId;
    if (typeof id === "string" && UUID.test(id)) return id;
  }
  return "";
}

/** The JSON list `manage_subagents` prints after "You have N active subagent(s):". */
function listedStates(output: unknown): SubagentCheck["states"] {
  const text = extractToolOutput(output);
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { conversationId?: unknown; role?: unknown; state?: unknown };
      if (typeof record.conversationId !== "string") return [];
      return [
        {
          id: record.conversationId,
          role: typeof record.role === "string" ? record.role : null,
          state: typeof record.state === "string" ? normalizeState(record.state) : "idle",
        },
      ];
    });
  } catch {
    return [];
  }
}

function normalizeState(state: string): string {
  const value = state.toLowerCase();
  if (value === "running" || value === "active") return "running";
  // agy reports a subagent that ended its turn as `idle`: in a check, that is a finished one.
  if (value === "completed" || value === "done" || value === "finished" || value === "idle") return "done";
  if (value === "killed" || value === "canceled" || value === "cancelled" || value === "stopped") return "stopped";
  if (value === "failed" || value === "error") return "failed";
  return value;
}

/** Ids and roles a `kill` or `kill_all` call names. */
function killedStates(input: unknown, output: unknown): SubagentCheck["states"] {
  const record = (input && typeof input === "object" ? input : {}) as { ConversationIds?: unknown };
  const ids = Array.isArray(record.ConversationIds)
    ? record.ConversationIds.filter((id): id is string => typeof id === "string")
    : [];
  const text = extractToolOutput(output);
  const roles = text ? (/Killed roles:\s*([^\n]+)/.exec(text)?.[1] ?? "").split(/,\s*/).filter(Boolean) : [];
  const reportedCount = text ? Number(/killed\s+(\d+)\s+subagent/i.exec(text)?.[1] ?? 0) : 0;
  const count = Math.max(ids.length, roles.length, Number.isFinite(reportedCount) ? reportedCount : 0);
  return Array.from({ length: count }, (_, index) => ({
    id: ids[index] ?? `#${index + 1}`,
    role: roles[index] ?? null,
    state: "stopped",
  }));
}

/**
 * Antigravity's own timeline rows:
 * - `invoke_subagent` becomes a live card of the child it started;
 * - `manage_subagents` becomes a one-line summary;
 * - `ask_question` becomes an interactive question card (and hides agy's duplicate plain-text list).
 */
export function registerSubagentTransforms(client: PluginClientContext) {
  const knownQuestionEchoes = new Set<string>();
  const echoFirstLines = new Set<string>();
  let maxEchoLength = 0;

  function rebuildEchoIndex() {
    echoFirstLines.clear();
    maxEchoLength = 0;
    for (const echo of knownQuestionEchoes) {
      if (echo.length > maxEchoLength) maxEchoLength = echo.length;
      const newline = echo.indexOf("\n");
      echoFirstLines.add(newline < 0 ? echo : echo.slice(0, newline));
    }
  }

  function rememberEcho(signature: string) {
    if (!signature) return;
    knownQuestionEchoes.delete(signature);
    knownQuestionEchoes.add(signature);
    if (knownQuestionEchoes.size > MAX_ECHO_CACHE) {
      const oldest = knownQuestionEchoes.keys().next().value;
      if (oldest) knownQuestionEchoes.delete(oldest);
      rebuildEchoIndex();
      return;
    }
    if (signature.length > maxEchoLength) maxEchoLength = signature.length;
    const newline = signature.indexOf("\n");
    echoFirstLines.add(newline < 0 ? signature : signature.slice(0, newline));
  }

  const removeToolTransform = client.addTimelineTransformer({
    id: "antigravity-subagents",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const status = item.status;
      if (item.name === "invoke_subagent" && item.detail.type === "sub_agent") {
        const detail = item.detail;
        const childId = detail.childSessionId && UUID.test(detail.childSessionId) ? detail.childSessionId : "";
        // Only agy's subagents: other providers have their own subagent views.
        if (childId && detail.log && !AGY_LOG.test(detail.log)) return undefined;
        const data: SubagentCard = {
          id: childId,
          type: detail.subAgentType ?? null,
          task: cut((detail.description ?? "").trim(), 600),
          status,
        };
        return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
      }
      // Paseo 0.17+ runs Antigravity over generic ACP where `invoke_subagent` arrives as `unknown` with `{ Prompt, Role, TypeName }`.
      if (item.name === "invoke_subagent" && item.detail.type === "unknown") {
        const input = item.detail.input as { Prompt?: unknown; Role?: unknown; TypeName?: unknown } | null;
        if (!input || typeof input !== "object") return undefined;
        const prompt = typeof input.Prompt === "string" ? input.Prompt.trim() : "";
        const role = typeof input.Role === "string" && input.Role.trim() ? input.Role.trim() : null;
        const typeName = typeof input.TypeName === "string" && input.TypeName.trim() ? input.TypeName.trim() : null;
        if (!prompt && !role && !typeName) return undefined;
        const data: SubagentCard = {
          id: extractChildId(item.detail.output),
          role,
          type: typeName,
          task: cut(prompt, 600),
          status,
        };
        return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
      }
      if (item.name === "manage_subagents" && item.detail.type === "unknown") {
        const input = item.detail.input as { Action?: unknown } | null;
        const action = typeof input?.Action === "string" ? input.Action : "";
        if (!action) return undefined;
        const states =
          action === "kill" || action === "kill_all"
            ? killedStates(item.detail.input, item.detail.output)
            : listedStates(item.detail.output);
        const data: SubagentCheck = { action, states, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }
      if (item.name === "ask_question" && item.detail.type === "unknown") {
        const questions = parseAskQuestions(item.detail.input);
        if (!questions) return undefined;
        if (questions.some((entry) => entry.options.length > 0)) {
          rememberEcho(formatQuestionEcho(questions));
        }
        const data: AskQuestionCard = {
          callId: item.callId,
          questions,
          output: extractToolOutput(item.detail.output),
          status,
        };
        return { items: [{ type: "plugin", kind: ASK_QUESTION_TIMELINE_KIND, version: 1, data }] };
      }
      return undefined;
    },
  });

  const removeEchoTransform = client.addTimelineTransformer({
    id: "antigravity-ask-question-echo",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      if (knownQuestionEchoes.size === 0) return undefined;
      if (item.text.length > maxEchoLength + 512) return undefined;
      const { line: firstLine, hasMore } = firstNonEmptyLine(item.text);
      if (!firstLine) return undefined;
      let firstLineMatches = echoFirstLines.has(firstLine);
      if (!firstLineMatches && phase === "streaming" && !hasMore && firstLine.length >= 12) {
        for (const candidate of echoFirstLines) {
          if (candidate.startsWith(firstLine)) {
            firstLineMatches = true;
            break;
          }
        }
      }
      if (!firstLineMatches) return undefined;
      const normalized = normalizeEchoText(item.text);
      if (!normalized) return undefined;
      if (knownQuestionEchoes.has(normalized)) {
        return { items: [] };
      }
      if (phase === "streaming" && normalized.length >= 12) {
        for (const echo of knownQuestionEchoes) {
          if (echo.startsWith(normalized)) return { items: [] };
        }
      }
      return undefined;
    },
  });

  return () => {
    removeToolTransform();
    removeEchoTransform();
    knownQuestionEchoes.clear();
    echoFirstLines.clear();
    maxEchoLength = 0;
  };
}
