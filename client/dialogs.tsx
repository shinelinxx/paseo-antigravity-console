import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsSelect, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  RECOVERY_FOLDER_NAME,
  inferPlanWeight,
  migrateAccountAgentsRpc,
  recoverSavedFilesRpc,
  savedFilesRpc,
  type AccountSummary,
  type RoutingMode,
  type SavedFiles,
} from "../shared/contracts";
import type { ObservedAgent } from "./agents";
import { displayLabel, shortPlan } from "./labels";
import { errorMessage, messages } from "./messages";
import { font, mono, radius, space, tabular, tint, type Colors } from "./theme";
import { Badge, Button, Callout, Divider, Muted } from "./ui";

export function NameDialog({
  colors,
  title,
  body,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  colors: Colors;
  title: string;
  body?: string;
  initial: string;
  confirmLabel: string;
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = name.trim().length > 0 && name.trim() !== initial.trim();

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={title} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {body ? <Muted colors={colors}>{body}</Muted> : null}
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.name")}</Text>
          <TextInput
            accessibilityLabel={t("dialog.name")}
            autoFocus
            maxLength={40}
            value={name}
            editable={!busy}
            onChangeText={setName}
            onSubmitEditing={() => void save()}
            placeholder={t("dialog.namePlaceholder")}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.body,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
            }}
          />
        </View>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="primary" label={confirmLabel} loading={busy} disabled={!valid} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Modal to set or clear a short note/tag on any account (system or profile). */
export function NoteDialog({
  colors,
  accountLabel,
  initial,
  onSubmit,
  onClose,
}: {
  colors: Colors;
  accountLabel: string;
  initial: string;
  onSubmit(note: string | null): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = note.trim() !== initial.trim();

  async function save(next: string | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(next && next.trim().length > 0 ? next.trim() : null);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.noteTitle", { label: accountLabel })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.noteHint")}</Muted>
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.noteLabel")}</Text>
          <TextInput
            accessibilityLabel={t("dialog.noteLabel")}
            autoFocus
            maxLength={80}
            value={note}
            editable={!busy}
            onChangeText={setNote}
            onSubmitEditing={() => void save(note)}
            placeholder={t("dialog.notePlaceholder")}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.body,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
            }}
          />
        </View>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          {initial.trim().length > 0 ? (
            <Button
              colors={colors}
              variant="ghost"
              label={t("dialog.noteClear")}
              disabled={busy}
              onPress={() => void save(null)}
            />
          ) : null}
          <View style={{ flex: 1 }} />
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="primary"
            label={t("dialog.save")}
            loading={busy}
            disabled={!changed}
            onPress={() => void save(note)}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Names shown in the Remove / Recover dialog before "and N more". */
const SHOWN_FILES = 6;

function SavedList({ colors, items }: { colors: Colors; items: string[] }) {
  const { t } = useTranslation(messages);
  // "and 1 more" takes the same line the last name would.
  const shown = items.length > SHOWN_FILES + 1 ? items.slice(0, SHOWN_FILES) : items;
  const rest = items.length - shown.length;
  return (
    <View style={{ gap: space.xxs }}>
      {shown.map((item) => (
        <Text key={item} numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
          {item}
        </Text>
      ))}
      {rest > 0 ? <Muted colors={colors} small>{t("dialog.removeMore", { count: rest })}</Muted> : null}
    </View>
  );
}

export function ConfirmRemove({
  colors,
  accountId,
  label,
  onConfirm,
  onClose,
}: {
  colors: Colors;
  accountId: string;
  label: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const listSaved = useRpc(savedFilesRpc);
  // null while checking; "unknown" when the check failed (removal still moves the files).
  const [saved, setSaved] = useState<SavedFiles | "unknown" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listSaved({ accountId }).then(
      (result) => live && setSaved(result),
      () => live && setSaved("unknown"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  return (
    <Modal open title={t("dialog.removeTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.removeBody")}</Muted>
        {/* The folder goes on a line of its own, so its spaces never split it. */}
        {saved === "unknown" ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFilesUnknown")}\n~/${RECOVERY_FOLDER_NAME}`}
          />
        ) : saved && saved.items.length > 0 ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFiles", { count: saved.items.length })}\n${saved.folder}`}
          >
            <SavedList colors={colors} items={saved.items} />
          </Callout>
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="danger"
            icon="Trash2"
            label={t("dialog.removeConfirm")}
            loading={busy}
            disabled={saved === null}
            onPress={() => {
              setBusy(true);
              setError("");
              void onConfirm().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
                setBusy(false);
              });
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Shows files agents created directly in a profile HOME and lets the user move them out safely. */
export function RecoverFilesDialog({
  colors,
  account,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const listSaved = useRpc(savedFilesRpc);
  const recover = useRpc(recoverSavedFilesRpc);
  const [saved, setSaved] = useState<SavedFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = displayLabel(account.label, t, account.kind);

  useEffect(() => {
    let live = true;
    setLoading(true);
    listSaved({ accountId: account.id }).then(
      (result) => {
        if (!live) return;
        setSaved(result);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(errorMessage(reason));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  async function onRecover() {
    setBusy(true);
    setError("");
    try {
      const { moved } = await recover({ accountId: account.id });
      if (moved) {
        const copiedCount = moved.copied?.length ?? 0;
        const movedCount = Math.max(0, moved.items.length - copiedCount);
        const message =
          copiedCount === 0
            ? t("dialog.removedMoved", { count: moved.items.length, folder: moved.folder })
            : movedCount === 0
              ? t("dialog.recoverCopied", { count: copiedCount, folder: moved.folder })
              : t("dialog.recoverMixed", { moved: movedCount, copied: copiedCount, folder: moved.folder });
        toast.show(message, {
          variant: "success",
          durationMs: copiedCount > 0 ? 10_000 : 8000,
        });
      }
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.recoverTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {loading ? (
          <Muted colors={colors}>{t("loading")}</Muted>
        ) : saved && saved.items.length > 0 ? (
          <>
            <Muted colors={colors}>{t("dialog.recoverBody")}</Muted>
            <Callout
              colors={colors}
              tone="neutral"
              icon="FolderInput"
              title={`${t("dialog.recoverFiles", { count: saved.items.length })}\n${saved.folder}`}
            >
              <SavedList colors={colors} items={saved.items} />
            </Callout>
          </>
        ) : !error ? (
          <Muted colors={colors}>{t("dialog.recoverEmpty")}</Muted>
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.close")} disabled={busy} onPress={onClose} />
          {saved && saved.items.length > 0 ? (
            <Button
              colors={colors}
              variant="primary"
              icon="FolderInput"
              label={t("dialog.recoverConfirm")}
              loading={busy}
              onPress={() => void onRecover()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Lists active agents running on an account and offers one-click bulk migration to another account. */
export function AccountAgentsDialog({
  colors,
  account,
  accounts,
  agents,
  onOpenAgent,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  accounts: readonly AccountSummary[];
  agents: readonly ObservedAgent[];
  onOpenAgent?: (agentId: string) => void;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const migrate = useRpc(migrateAccountAgentsRpc);
  const label = displayLabel(account.label, t, account.kind);
  const targets = useMemo(
    () =>
      accounts.filter(
        (entry) => entry.id !== account.id && entry.usable && entry.status !== "signed-out",
      ),
    [accounts, account.id],
  );
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? "");
  const [mode, setMode] = useState<"after-turn" | "idle-only" | "now">("after-turn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!targets.some((entry) => entry.id === targetId)) {
      setTargetId(targets[0]?.id ?? "");
    }
  }, [targets, targetId]);

  async function onMigrate() {
    if (!targetId || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await migrate({
        fromAccountId: account.id,
        toAccountId: targetId,
        mode,
      });
      const targetAccount = targets.find((entry) => entry.id === targetId);
      const summary = t("dialog.migrateDone", {
        label: displayLabel(result.targetLabel, t, targetAccount?.kind),
        switched: result.switched,
        scheduled: result.scheduled,
        skipped: result.skipped,
      });
      if (result.failed.length > 0) {
        const details = result.failed
          .slice(0, 3)
          .map((item) => `${item.title?.trim() || item.agentId.slice(0, 12)}: ${item.error}`)
          .join("\n");
        setError(`${summary} ${t("dialog.migrateFailed", { count: result.failed.length })}\n${details}`);
        setBusy(false);
      } else {
        toast.show(summary, { variant: "success", durationMs: 6000 });
        onClose();
      }
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.agentsTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {agents.length === 0 ? (
          <Muted colors={colors}>{t("dialog.agentsEmpty")}</Muted>
        ) : (
          <View style={{ gap: space.xs }}>
            {agents.map((member) => (
              <View
                key={member.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.xs + 2,
                  paddingHorizontal: space.sm,
                  borderRadius: radius.md,
                  backgroundColor: colors.surface1,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Icon name="Bot" size={14} color={member.running ? colors.accent : colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>
                    {member.title?.trim() || member.id.slice(0, 12)}
                  </Text>
                  {member.model ? (
                    <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
                      {member.model}
                    </Text>
                  ) : null}
                </View>
                <Badge
                  colors={colors}
                  label={member.running ? t("dialog.agentsRunning") : t("dialog.agentsIdle")}
                  tone={member.running ? "accent" : "neutral"}
                  dot
                />
                {onOpenAgent ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("dialog.agentsOpen")}
                    onPress={() => {
                      onClose();
                      onOpenAgent(member.id);
                    }}
                    style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
                  >
                    <Text style={{ ...font.caption, fontWeight: "600", color: colors.accent }}>
                      {t("dialog.agentsOpen")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {agents.length > 0 ? (
          <>
            <Divider colors={colors} />
            <Text style={{ ...font.heading, color: colors.foreground }}>{t("dialog.migrateHeading")}</Text>
            {targets.length === 0 ? (
              <Muted colors={colors}>{t("dialog.migrateNoTarget")}</Muted>
            ) : (
              <View style={{ gap: space.sm }}>
                <SettingsSelect
                  label={t("dialog.migrateTarget")}
                  value={targetId}
                  options={targets.map((entry) => {
                    const name = displayLabel(entry.label, t, entry.kind);
                    return {
                      value: entry.id,
                      label: [name, entry.note, shortPlan(entry.plan, name)].filter(Boolean).join(" · "),
                    };
                  })}
                  onValueChange={setTargetId}
                  disabled={busy}
                />
                <SettingsSelect
                  label={t("dialog.migrateMode")}
                  value={mode}
                  options={[
                    { value: "after-turn", label: t("dialog.migrateModeAfterTurn") },
                    { value: "idle-only", label: t("dialog.migrateModeIdleOnly") },
                    { value: "now", label: t("dialog.migrateModeNow") },
                  ]}
                  onValueChange={(value) => setMode(value as "after-turn" | "idle-only" | "now")}
                  disabled={busy}
                />
              </View>
            )}
          </>
        ) : null}

        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.close")} disabled={busy} onPress={onClose} />
          {agents.length > 0 && targets.length > 0 ? (
            <Button
              colors={colors}
              variant="primary"
              icon="ArrowLeftRight"
              label={t("dialog.migrateAction")}
              loading={busy}
              onPress={() => void onMigrate()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

function formatWeightNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** Edits an account's load-balancing weight override (null = auto from plan, 0 = excluded). */
export function WeightDialog({
  colors,
  account,
  onSave,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  onSave(weight: number | null): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const label = displayLabel(account.label, t, account.kind);
  const inferred = inferPlanWeight(account.plan);
  const [useAuto, setUseAuto] = useState(account.weight === null);
  const [input, setInput] = useState(
    account.weight === null ? formatWeightNumber(inferred) : formatWeightNumber(account.weight),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parsed = Number(input.trim());
  const customValid = input.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
  const presets = [0, 1, 5, 10, 20];

  async function save() {
    if (busy) return;
    if (!useAuto && !customValid) {
      setError(t("dialog.weightInvalid"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(useAuto ? null : Number(parsed.toFixed(2)));
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.weightTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.weightBody")}</Muted>
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.weightPresets")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
            <Button
              colors={colors}
              size="sm"
              variant={useAuto ? "primary" : "secondary"}
              label={t("dialog.weightAuto", { weight: formatWeightNumber(inferred) })}
              disabled={busy}
              onPress={() => {
                setUseAuto(true);
                setInput(formatWeightNumber(inferred));
                setError("");
              }}
            />
            {presets.map((preset) => {
              const active = !useAuto && customValid && Math.abs(parsed - preset) < 1e-6;
              return (
                <Button
                  key={preset}
                  colors={colors}
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  label={preset === 0 ? t("dialog.weightExclude") : `${preset}x`}
                  disabled={busy}
                  onPress={() => {
                    setUseAuto(false);
                    setInput(String(preset));
                    setError("");
                  }}
                />
              );
            })}
          </View>
        </View>
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.weightInput")}</Text>
          <TextInput
            accessibilityLabel={t("dialog.weightInput")}
            keyboardType="decimal-pad"
            value={input}
            editable={!busy}
            onChangeText={(text) => {
              setUseAuto(false);
              setInput(text);
              setError("");
            }}
            onSubmitEditing={() => void save()}
            placeholder={formatWeightNumber(inferred)}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.body,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
              opacity: useAuto ? 0.6 : 1,
            }}
          />
        </View>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="primary"
            label={t("dialog.save")}
            loading={busy}
            disabled={!useAuto && !customValid}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

const RATIO_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#6366f1",
] as const;

function ratioSegmentColor(index: number, colors: Colors): string {
  return index === 0 ? colors.accent : RATIO_PALETTE[index % RATIO_PALETTE.length]!;
}

/** Modal to configure custom load-balancing ratios across all accounts at once. */
export function RoutingRatioDialog({
  colors,
  accounts,
  routingMode,
  onSave,
  onClose,
}: {
  colors: Colors;
  accounts: readonly AccountSummary[];
  routingMode: RoutingMode;
  onSave(entries: { accountId: string; weight: number | null }[], mode: RoutingMode): Promise<void>;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const [selectedMode, setSelectedMode] = useState<"ratio" | "balanced">(
    routingMode === "balanced" ? "balanced" : "ratio",
  );
  const [autoIds, setAutoIds] = useState<ReadonlySet<string>>(
    () => new Set(accounts.filter((account) => account.weight === null).map((account) => account.id)),
  );
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const account of accounts) {
      const value = account.weight ?? inferPlanWeight(account.plan);
      initial[account.id] = formatWeightNumber(value);
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parsedRows = useMemo(() => {
    return accounts.map((account, index) => {
      const isAuto = autoIds.has(account.id);
      const inferred = inferPlanWeight(account.plan);
      const raw = (inputs[account.id] ?? "").trim();
      const num = isAuto ? inferred : Number(raw);
      const valid = isAuto || (raw.length > 0 && Number.isFinite(num) && num >= 0 && num <= 100);
      const effective = valid ? (isAuto ? inferred : num) : 0;
      const eligible = account.usable && account.status !== "signed-out";
      return {
        account,
        index,
        color: ratioSegmentColor(index, colors),
        isAuto,
        inferred,
        valid,
        effective,
        eligible,
      };
    });
  }, [accounts, autoIds, inputs, colors]);

  const allValid = parsedRows.every((row) => row.valid);
  const activeTotal = parsedRows.reduce((sum, row) => sum + (row.eligible ? row.effective : 0), 0);
  const allTotal = parsedRows.reduce((sum, row) => sum + row.effective, 0);
  const shareDenominator = activeTotal > 0 ? activeTotal : allTotal;
  const eligibleAccounts = useMemo(
    () => accounts.filter((account) => account.usable && account.status !== "signed-out"),
    [accounts],
  );
  const usableIds = useMemo(
    () => (eligibleAccounts.length > 0 ? eligibleAccounts : accounts.filter((a) => a.usable)).map((a) => a.id),
    [eligibleAccounts, accounts],
  );

  function applyAutoPreset() {
    const nextAuto = new Set<string>();
    const nextInputs: Record<string, string> = {};
    for (const account of accounts) {
      nextAuto.add(account.id);
      nextInputs[account.id] = formatWeightNumber(inferPlanWeight(account.plan));
    }
    setAutoIds(nextAuto);
    setInputs(nextInputs);
    setError("");
  }

  function applyEqualPreset() {
    const targetSet = new Set(usableIds);
    const shareValue = targetSet.size === 2 ? 50 : targetSet.size === 4 ? 25 : 1;
    const nextInputs: Record<string, string> = {};
    for (const account of accounts) {
      nextInputs[account.id] = targetSet.has(account.id) ? String(shareValue) : "0";
    }
    setAutoIds(new Set());
    setInputs(nextInputs);
    setError("");
  }

  function applySplitPreset(primaryPct: number) {
    if (usableIds.length < 2) return;
    const primaryId = usableIds[0]!;
    const restIds = usableIds.slice(1);
    const restEach = Number(((100 - primaryPct) / restIds.length).toFixed(2));
    const restSet = new Set(restIds);
    const nextInputs: Record<string, string> = {};
    for (const account of accounts) {
      if (account.id === primaryId) nextInputs[account.id] = String(primaryPct);
      else if (restSet.has(account.id)) nextInputs[account.id] = formatWeightNumber(restEach);
      else nextInputs[account.id] = "0";
    }
    setAutoIds(new Set());
    setInputs(nextInputs);
    setSelectedMode("ratio");
    setError("");
  }

  async function save() {
    if (busy) return;
    if (!allValid) {
      setError(t("dialog.ratioInvalid"));
      return;
    }
    if (shareDenominator <= 0) {
      setError(t("dialog.ratioZeroWarning"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const entries = parsedRows.map((row) => ({
        accountId: row.account.id,
        weight: row.isAuto ? null : Number(row.effective.toFixed(2)),
      }));
      await onSave(entries, selectedMode);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  const splitPresets = usableIds.length >= 2 ? [90, 80, 70] : [];

  return (
    <Modal open title={t("dialog.ratioTitle")} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.ratioBody")}</Muted>

        {/* Stacked live proportion bar */}
        <View style={{ gap: space.xs + 2 }}>
          <View
            style={{
              height: 10,
              borderRadius: radius.pill,
              overflow: "hidden",
              flexDirection: "row",
              backgroundColor: tint(colors.foregroundMuted, 0.16),
              gap: 2,
            }}
          >
            {parsedRows.map((row) => {
              const weightForBar = activeTotal > 0 ? (row.eligible ? row.effective : 0) : row.effective;
              if (weightForBar <= 0 || shareDenominator <= 0) return null;
              return (
                <View
                  key={row.account.id}
                  style={{
                    flex: weightForBar,
                    backgroundColor: row.color,
                  }}
                />
              );
            })}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {parsedRows.map((row) => {
              const label = displayLabel(row.account.label, t, row.account.kind);
              const weightForBar = activeTotal > 0 ? (row.eligible ? row.effective : 0) : row.effective;
              const pct = shareDenominator > 0 ? Math.round((weightForBar / shareDenominator) * 100) : 0;
              return (
                <View key={row.account.id} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: weightForBar > 0 ? row.color : tint(colors.foregroundMuted, 0.35),
                    }}
                  />
                  <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                    {label} {weightForBar > 0 ? `${pct}%` : t("dialog.ratioExcluded")}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Quick presets */}
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.ratioPresets")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
            <Button
              colors={colors}
              size="sm"
              variant={autoIds.size === accounts.length ? "primary" : "secondary"}
              label={t("dialog.ratioPresetAuto")}
              disabled={busy}
              onPress={applyAutoPreset}
            />
            {usableIds.length >= 2 ? (
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                label={t("dialog.ratioPresetEqual")}
                disabled={busy}
                onPress={applyEqualPreset}
              />
            ) : null}
            {splitPresets.map((primaryPct) => (
              <Button
                key={primaryPct}
                colors={colors}
                size="sm"
                variant="secondary"
                label={`${primaryPct} : ${100 - primaryPct}`}
                disabled={busy}
                onPress={() => applySplitPreset(primaryPct)}
              />
            ))}
          </View>
        </View>

        <Divider colors={colors} />

        {/* Per-account ratio rows */}
        <View style={{ gap: space.sm }}>
          {parsedRows.map((row) => {
            const label = displayLabel(row.account.label, t, row.account.kind);
            const planTag = shortPlan(row.account.plan, label);
            const weightForBar = activeTotal > 0 ? (row.eligible ? row.effective : 0) : row.effective;
            const pct = shareDenominator > 0 && weightForBar > 0 ? Math.round((weightForBar / shareDenominator) * 100) : 0;
            const isExcluded = !row.isAuto && row.valid && row.effective === 0;
            return (
              <View
                key={row.account.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.xs,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: weightForBar > 0 ? row.color : tint(colors.foregroundMuted, 0.3),
                  }}
                />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    <Text numberOfLines={1} style={{ ...font.body, fontWeight: "500", color: colors.foreground, flexShrink: 1 }}>
                      {label}
                    </Text>
                    {planTag ? <Badge colors={colors} label={planTag} /> : null}
                    <Badge
                      colors={colors}
                      label={row.isAuto ? t("dialog.ratioAutoTag") : t("dialog.ratioCustomTag")}
                      tone={row.isAuto ? "neutral" : "accent"}
                    />
                  </View>
                  {!row.eligible ? (
                    <Text style={{ ...font.caption, color: colors.statusWarning }}>
                      {row.account.usable ? t(`status.${row.account.status}`) : t("callout.unusableTitle")}
                    </Text>
                  ) : null}
                </View>
                <TextInput
                  accessibilityLabel={label}
                  keyboardType="decimal-pad"
                  value={inputs[row.account.id] ?? ""}
                  editable={!busy}
                  onChangeText={(text) => {
                    setAutoIds((prev) => {
                      const next = new Set(prev);
                      next.delete(row.account.id);
                      return next;
                    });
                    setInputs((prev) => ({ ...prev, [row.account.id]: text }));
                    setError("");
                  }}
                  placeholder={formatWeightNumber(row.inferred)}
                  placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
                  style={{
                    ...font.body,
                    ...tabular,
                    width: 72,
                    textAlign: "right",
                    color: row.valid ? colors.foreground : colors.statusDanger,
                    backgroundColor: colors.surface0,
                    borderColor: row.valid ? colors.border : colors.statusDanger,
                    borderWidth: 1,
                    borderRadius: radius.md,
                    paddingHorizontal: space.sm,
                    paddingVertical: space.xs + 2,
                    opacity: row.isAuto ? 0.72 : 1,
                  }}
                />
                <Text
                  style={{
                    ...font.small,
                    ...tabular,
                    width: 44,
                    textAlign: "right",
                    color: weightForBar > 0 ? colors.foreground : colors.foregroundMuted,
                    fontWeight: weightForBar > 0 ? "600" : "400",
                  }}
                >
                  {weightForBar > 0 ? `${pct}%` : "0%"}
                </Text>
                <Button
                  colors={colors}
                  size="sm"
                  variant={isExcluded ? "secondary" : "ghost"}
                  label={isExcluded ? t("dialog.ratioAutoTag") : "0"}
                  disabled={busy}
                  onPress={() => {
                    if (isExcluded) {
                      setAutoIds((prev) => new Set(prev).add(row.account.id));
                      setInputs((prev) => ({ ...prev, [row.account.id]: formatWeightNumber(row.inferred) }));
                    } else {
                      setAutoIds((prev) => {
                        const next = new Set(prev);
                        next.delete(row.account.id);
                        return next;
                      });
                      setInputs((prev) => ({ ...prev, [row.account.id]: "0" }));
                    }
                    setError("");
                  }}
                />
              </View>
            );
          })}
        </View>

        <Divider colors={colors} />

        {/* Mode toggle: Strict ratio vs Dynamic weighted */}
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.ratioModeLabel")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
            <Button
              colors={colors}
              size="sm"
              variant={selectedMode === "ratio" ? "primary" : "secondary"}
              label={t("dialog.ratioModeStrict")}
              disabled={busy}
              onPress={() => setSelectedMode("ratio")}
            />
            <Button
              colors={colors}
              size="sm"
              variant={selectedMode === "balanced" ? "primary" : "secondary"}
              label={t("dialog.ratioModeBalanced")}
              disabled={busy}
              onPress={() => setSelectedMode("balanced")}
            />
          </View>
          <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
            {selectedMode === "ratio" ? t("dialog.ratioModeStrictHint") : t("dialog.ratioModeBalancedHint")}
          </Text>
        </View>

        {shareDenominator <= 0 && allValid ? (
          <Callout colors={colors} tone="warning" icon="TriangleAlert" title={t("dialog.ratioZeroWarning")} />
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="primary"
            label={t("dialog.save")}
            loading={busy}
            disabled={!allValid || shareDenominator <= 0}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
