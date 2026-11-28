import {
  useTranslation,
  type PluginButtonContentProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { AgentStep, CompactToolCard, StepStatus, TaskSnapshot, UpdateStepsCard } from "../shared/contracts";
import { updateStepsReceipt } from "../shared/contracts";
import { messages } from "./messages";
import { font, mono, radius, space, tabular, tint, toneColor, type Colors, type Tone } from "./theme";
import { Bar } from "./ui";

/** Latest confirmed checklist for each agent with a Tasks pill. */
class TasksStore {
  private readonly values = new Map<string, TaskSnapshot>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get(agentId: string): TaskSnapshot | undefined {
    return this.values.get(agentId);
  }

  set(agentId: string, snapshot: TaskSnapshot | null): void {
    const previous = this.values.get(agentId);
    if (!snapshot || snapshot.steps.length === 0) {
      if (this.values.delete(agentId)) this.emit();
      return;
    }
    if (
      previous &&
      previous.planId === snapshot.planId &&
      previous.revision === snapshot.revision &&
      JSON.stringify(previous.steps) === JSON.stringify(snapshot.steps)
    ) {
      return;
    }
    this.values.set(agentId, snapshot);
    this.emit();
  }

  delete(agentId: string): void {
    if (this.values.delete(agentId)) this.emit();
  }

  clear(): void {
    const hadData = this.values.size > 0;
    this.values.clear();
    if (hadData) this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.version;

  private emit(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const tasksStore = new TasksStore();

const STEP_ICON: Record<StepStatus, string> = {
  done: "CircleCheck",
  in_progress: "CircleDot",
  pending: "Circle",
  skipped: "CircleSlash",
  failed: "CircleAlert",
};

const STEP_TONE: Record<StepStatus, Tone> = {
  done: "success",
  in_progress: "accent",
  pending: "neutral",
  skipped: "neutral",
  failed: "danger",
};

export function countSteps(steps: readonly AgentStep[]) {
  let done = 0;
  let inProgress = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.status === "done" || step.status === "skipped") done += 1;
    else if (step.status === "in_progress") inProgress += 1;
    else if (step.status === "failed") failed += 1;
  }
  return { done, inProgress, failed, total: steps.length };
}

function StepLine({ colors, step }: { colors: Colors; step: AgentStep }) {
  const iconColor = toneColor(colors, STEP_TONE[step.status]);
  const muted = step.status === "done" || step.status === "skipped";
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <View style={{ paddingTop: 2 }}>
        <Icon name={STEP_ICON[step.status]} size={13} color={iconColor} />
      </View>
      <Text
        style={{
          ...font.small,
          flex: 1,
          color:
            step.status === "failed"
              ? colors.statusDanger
              : muted
                ? colors.foregroundMuted
                : colors.foreground,
          fontWeight: step.status === "in_progress" ? "600" : "400",
          textDecorationLine: step.status === "skipped" ? "line-through" : "none",
        }}
      >
        {step.title}
      </Text>
    </View>
  );
}

function stepsSig(steps: readonly AgentStep[]) {
  return JSON.stringify(steps.map(step => [step.title.trim(), step.status]));
}

function prefixSig(steps: readonly AgentStep[], { total, done, failed }: NonNullable<UpdateStepsCard["counts"]>) {
  return JSON.stringify([total, done, failed, stepsSig(steps.slice(0, 50))]);
}

type CompletedCall = {
  agentId: string;
  callId: string;
  receipt: string;
  counts: NonNullable<UpdateStepsCard["counts"]>;
  fullSig: string;
  prefix50Sig: string;
};

const completedStepsStore = (() => {
  const agents = new Map<string, Map<string, CompletedCall>>();
  const rendering = new Set<CompletedCall>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(fn => fn());
  return {
    matches(agentId: string, match: (call: CompletedCall) => boolean) {
      for (const call of agents.get(agentId)?.values() ?? []) if (match(call)) return true;
      for (const call of rendering) if (call.agentId === agentId && match(call)) return true;
      return false;
    },
    markRendering(call: CompletedCall) {
      if (agents.get(call.agentId)?.get(call.callId) === call || rendering.has(call)) return;
      rendering.add(call);
      queueMicrotask(() => {
        if (rendering.delete(call)) notify();
      });
    },
    commit(call: CompletedCall) {
      rendering.delete(call);
      const calls = agents.get(call.agentId) ?? new Map<string, CompletedCall>();
      calls.delete(call.callId);
      calls.set(call.callId, call);
      if (calls.size > 128) calls.delete(calls.keys().next().value!);
      agents.delete(call.agentId);
      agents.set(call.agentId, calls);
      if (agents.size > 64) agents.delete(agents.keys().next().value!);
      notify();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
})();

export function UpdateStepsRow(props: PluginTimelineItemProps<UpdateStepsCard>) {
  const { agentId } = props;
  const { callId, status, steps } = props.item.data;
  const call = useMemo(() => {
    if (status !== "completed" || !callId || !agentId) return null;
    const counts = countSteps(steps);
    return { agentId, callId, counts, receipt: updateStepsReceipt(callId, steps),
      fullSig: stepsSig(steps), prefix50Sig: prefixSig(steps, counts) };
  }, [agentId, callId, status, steps]);
  if (call) completedStepsStore.markRendering(call);
  useLayoutEffect(() => { if (call) completedStepsStore.commit(call); }, [call]);
  return <StepsRowContent {...props} />;
}

export function LegacyUpdateStepsRow(props: PluginTimelineItemProps<UpdateStepsCard>) {
  const { agentId, item: { data } } = props;
  const match = useMemo(() => {
    if (typeof data.planId !== "string" || data.callId !== undefined) return null;
    const counts = data.counts ?? countSteps(data.steps);
    if (counts.total > data.steps.length) {
      // A shared receipt list cannot identify which call supplied the omitted tail.
      if (data.coveredCalls?.length !== 1 || data.steps.length !== 50) return null;
      const [receipt] = data.coveredCalls;
      const prefix = prefixSig(data.steps, counts);
      return (call: CompletedCall) => call.receipt === receipt && call.prefix50Sig === prefix;
    }
    const full = stepsSig(data.steps);
    const covered = data.coveredCalls ? new Set(data.coveredCalls) : null;
    return (call: CompletedCall) => (!covered || covered.has(call.receipt) || covered.has(call.callId))
      && call.counts.total === counts.total && call.counts.done === counts.done
      && call.counts.failed === counts.failed && call.fullSig === full;
  }, [data]);
  const visibleSource = useSyncExternalStore(completedStepsStore.subscribe,
    () => !!(agentId && match && completedStepsStore.matches(agentId, match)), () => false);
  if (visibleSource) return null;
  return <StepsRowContent {...props} />;
}

/** Each timeline item keeps the checklist as it was at this call. */
function StepsRowContent({ item, theme }: PluginTimelineItemProps<UpdateStepsCard>) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const [expanded, setExpanded] = useState(false);
  const { steps, status, error } = item.data;
  const { done, total, failed } = item.data.counts ?? countSteps(steps);
  const rejected = status === "failed" || status === "canceled";
  const tone = rejected || failed > 0 ? "danger" : total > 0 && done === total ? "success" : "accent";
  const color = toneColor(colors, tone);
  let title = total ? t("tasks.title") : t("tasks.cleared");
  if (status === "failed") title = t("tasks.updateFailed");
  if (status === "canceled") title = t("tasks.updateCanceled");
  const active = steps.find((step) => step.status === "in_progress");
  const hasDetail = !!(steps.length || error);
  return (
    <View>
      <Pressable accessibilityRole="button" disabled={!hasDetail} accessibilityState={{ expanded, disabled: !hasDetail }}
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 24, gap: space.sm }}>
        <Icon name={rejected ? "CircleAlert" : "ListChecks"} size={13} color={color} />
        <Text numberOfLines={1} style={{ ...font.small, flexShrink: 1, color }}>
          {[title, total ? `${done}/${total}` : null, active?.title].filter(Boolean).join(" · ")}
        </Text>
        {hasDetail && <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} />}
      </Pressable>
      {expanded && hasDetail && (
        <View style={{ marginLeft: 20, paddingVertical: space.xs, gap: space.sm }}>
          {error && <Text selectable style={{ ...font.small, color: colors.statusDanger }}>{error}</Text>}
          {total > 0 && <Bar colors={colors} fraction={done / total} tone={tone} height={4} />}
          {total > steps.length && <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
            {t("tasks.showingFirst", { count: steps.length })}
          </Text>}
          {steps.map((step, index) => <StepLine key={index} colors={colors} step={step} />)}
        </View>
      )}
    </View>
  );
}

/** Popover anchored to the live Tasks composer pill. */
export function TasksPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const agentId = props.context === "agent" ? props.agentId : null;
  useSyncExternalStore(tasksStore.subscribe, tasksStore.snapshot);
  const steps = agentId ? tasksStore.get(agentId)?.steps : undefined;

  if (!steps || steps.length === 0) {
    return (
      <View style={{ width: layout.compact ? "100%" : 320, gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground }}>{t("tasks.title")}</Text>
        <Text style={{ ...font.small, color: colors.foregroundMuted }}>{t("tasks.empty")}</Text>
      </View>
    );
  }

  const { done, failed, total } = countSteps(steps);
  const barTone: Tone = failed > 0 ? "danger" : done === total ? "success" : "accent";

  return (
    <View style={{ width: layout.compact ? "100%" : 340, gap: space.md }}>
      <View style={{ gap: space.xs + 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Icon name="ListChecks" size={16} color={toneColor(colors, barTone)} />
          <Text style={{ ...font.heading, color: colors.foreground, flex: 1 }}>{t("tasks.title")}</Text>
          <Text style={{ ...font.small, ...tabular, fontWeight: "600", color: toneColor(colors, barTone) }}>
            {`${done}/${total}`}
          </Text>
        </View>
        <Bar colors={colors} fraction={total > 0 ? done / total : 0} tone={barTone} height={5} />
      </View>
      <ScrollView style={{ maxHeight: layout.compact ? 360 : 300 }} contentContainerStyle={{ gap: space.sm }}>
        {steps.map((step, index) => (
          <StepLine key={`${index}:${step.title}`} colors={colors} step={step} />
        ))}
      </ScrollView>
    </View>
  );
}

const COMPACT_ICON: Record<CompactToolCard["tool"], string> = {
  schedule: "Timer",
  run_workflow: "Workflow",
  send_message: "Send",
};

/** One-line localized expandable summary row for `schedule`, `run_workflow`, and `send_message`. */
export function CompactToolRow({ item, theme }: PluginTimelineItemProps<CompactToolCard>) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const data = item.data;
  const hasBody = Boolean(data.detail || data.output);
  const failed = data.status === "failed";
  const running = data.status === "running";
  const iconColor = failed ? colors.statusDanger : running ? colors.accent : colors.foregroundMuted;

  let localizedTitle: string;
  if (data.tool === "schedule") {
    if (data.variant === "cron" && data.expr) {
      localizedTitle = t("tools.scheduleCron", { expr: data.expr });
    } else if (data.variant === "timer" && data.expr) {
      localizedTitle = t("tools.scheduleTimer", { expr: data.expr });
    } else {
      localizedTitle = data.title || t("tools.schedule");
    }
  } else if (data.tool === "run_workflow") {
    if (data.label) {
      localizedTitle = data.label;
    } else if (data.expr) {
      localizedTitle = t("tools.workflowNamed", { name: data.expr });
    } else {
      localizedTitle = data.title || t("tools.workflow");
    }
  } else {
    if (data.target) {
      localizedTitle = t("tools.messageTo", { target: data.target });
    } else {
      localizedTitle = data.title || t("tools.message");
    }
  }

  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !hasBody }}
        disabled={!hasBody}
        onPress={() => setOpen((value) => !value)}
        style={(pressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          paddingVertical: space.xs,
          paddingHorizontal: 7,
          marginHorizontal: -6,
          borderRadius: radius.md,
          backgroundColor: hasBody && (pressState as { hovered?: boolean }).hovered ? tint(colors.foreground, 0.05) : "transparent",
        })}
      >
        <Icon name={failed ? "CircleAlert" : COMPACT_ICON[data.tool]} size={13} color={iconColor} />
        <Text numberOfLines={1} style={{ ...font.small, fontWeight: "500", color: failed ? colors.statusDanger : colors.foreground }}>
          {localizedTitle}
        </Text>
        {data.subtitle ? (
          <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>
            {data.subtitle}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {running ? (
          <Text style={{ ...font.caption, color: colors.accent }}>{t("subagents.state.running")}</Text>
        ) : failed ? (
          <Text style={{ ...font.caption, color: colors.statusDanger }}>{t("subagents.state.failed")}</Text>
        ) : null}
        {hasBody ? <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} /> : null}
      </Pressable>
      {open && hasBody ? (
        <View
          style={{
            marginLeft: 18,
            padding: space.sm + 2,
            borderRadius: radius.md,
            backgroundColor: tint(colors.foreground, 0.04),
            gap: space.xs + 2,
          }}
        >
          {data.detail ? (
            <Text selectable style={{ ...font.caption, color: colors.foreground }}>
              {data.detail}
            </Text>
          ) : null}
          {data.output ? (
            <Text selectable style={{ fontSize: 12, lineHeight: 17, fontFamily: mono, color: colors.foregroundMuted }}>
              {data.output}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
