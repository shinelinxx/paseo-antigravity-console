import { useRpc, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsCard, SettingsRow, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import {
  clearCooldownRpc,
  createAccountRpc,
  moveAccountRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  setAccountOptionsRpc,
  setDefaultAccountRpc,
  setFallbackRpc,
  signOutAccountRpc,
  type AccountSummary,
  type FallbackStrategy,
} from "../shared/contracts";
import { AccountCard, type CardAction } from "./AccountCard";
import type { AgentObservation } from "./agents";
import { AccountAgentsDialog, ConfirmRemove, NameDialog, RecoverFilesDialog } from "./dialogs";
import { displayLabel } from "./labels";
import { antigravityLogoSvg } from "./logo";
import { errorMessage, messages } from "./messages";
import { AccountOrchestratorDialog, OrchestratorRows } from "./orchestrator";
import { SignIn } from "./signIn";
import { UsageSection } from "./stats";
import { font, radius, space, tint, type Colors } from "./theme";
import { Avatar, Button, Callout, Muted } from "./ui";
import { useAccounts } from "./useAccounts";

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; account: AccountSummary }
  | { kind: "remove"; account: AccountSummary }
  | { kind: "signIn"; account: AccountSummary }
  | { kind: "recoverFiles"; account: AccountSummary }
  | { kind: "manageAgents"; account: AccountSummary }
  | { kind: "orchestratorOverride"; account: AccountSummary };

function SectionTitle({ colors, title, count }: { colors: Colors; title: string; count?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
      <Text style={{ ...font.heading, color: colors.foreground }}>{title}</Text>
      {count !== undefined ? <Text style={{ ...font.small, color: colors.foregroundMuted }}>{count}</Text> : null}
    </View>
  );
}

function AddAccountCard({ colors, onAdd }: { colors: Colors; onAdd(): void }) {
  const { t } = useTranslation(messages);
  return (
    <View
      style={{
        flexGrow: 1,
        minHeight: 160,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: colors.border,
        borderRadius: radius.lg,
        padding: space.xl,
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tint(colors.accent, 0.14),
        }}
      >
        <Icon name="UserPlus" size={20} color={colors.accent} />
      </View>
      <Text style={{ ...font.heading, color: colors.foreground, textAlign: "center" }}>{t("empty.title")}</Text>
      <Button colors={colors} variant="primary" icon="Plus" label={t("add")} onPress={onAdd} />
    </View>
  );
}

export function AccountsScreen({ theme, layout, navigation, host, observation }: PluginSurfaceProps & { observation: AgentObservation }) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const { data, error, accept, refetch } = useAccounts();
  const counts = useSyncExternalStore(observation.subscribe, observation.counts);
  const members = useSyncExternalStore(observation.subscribe, observation.members);
  const create = useRpc(createAccountRpc);
  const refresh = useRpc(refreshAccountsRpc);
  const rename = useRpc(renameAccountRpc);
  const move = useRpc(moveAccountRpc);
  const setOptions = useRpc(setAccountOptionsRpc);
  const clearCooldown = useRpc(clearCooldownRpc);
  const remove = useRpc(removeAccountRpc);
  const setDefault = useRpc(setDefaultAccountRpc);
  const setFallback = useRpc(setFallbackRpc);
  const signOut = useRpc(signOutAccountRpc);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, CardAction | null>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(0);
  const dialogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      if (dialogTimerRef.current) clearTimeout(dialogTimerRef.current);
    };
  }, []);

  const compact = layout.compact || (width > 0 && width < 560);
  const useModalMenu = compact || Platform.OS !== "web";

  function openDialog(next: Dialog, fromClosingModal = false) {
    if (dialogTimerRef.current) {
      clearTimeout(dialogTimerRef.current);
      dialogTimerRef.current = null;
    }
    if (fromClosingModal && Platform.OS !== "web") {
      dialogTimerRef.current = setTimeout(() => {
        dialogTimerRef.current = null;
        setDialog(next);
      }, 180);
      return;
    }
    setDialog(next);
  }

  async function track(accountId: string, action: CardAction, task: () => Promise<void>) {
    setBusy((current) => ({ ...current, [accountId]: action }));
    try {
      await task();
    } catch (reason) {
      toast.error(errorMessage(reason));
    } finally {
      setBusy((current) => ({ ...current, [accountId]: null }));
    }
  }

  function onAction(account: AccountSummary, action: CardAction) {
    const wasModalMenuOpen = Boolean(openMenuId) && useModalMenu;
    setOpenMenuId(null);
    const input = { accountId: account.id };
    switch (action) {
      case "refresh":
        return void track(account.id, action, async () => {
          accept(await refresh(input));
        });
      case "makeDefault":
        return void track(account.id, action, async () => {
          accept(await setDefault(input));
        });
      case "moveUp":
        return void track(account.id, action, async () => {
          accept(await move({ accountId: account.id, direction: "up" }));
        });
      case "moveDown":
        return void track(account.id, action, async () => {
          accept(await move({ accountId: account.id, direction: "down" }));
        });
      case "toggleFallback":
        return void track(account.id, action, async () => {
          accept(await setOptions({ accountId: account.id, fallbackEnabled: !account.fallbackEnabled }));
        });
      case "clearCooldown":
        return void track(account.id, action, async () => {
          accept(await clearCooldown(input));
          toast.show(t("cooldownCleared", { label: displayLabel(account.label, t, account.kind) }), { variant: "success" });
        });
      case "signOut":
        return void track(account.id, action, async () => {
          accept(await signOut(input));
        });
      case "rename":
        return openDialog({ kind: "rename", account }, wasModalMenuOpen);
      case "remove":
        return openDialog({ kind: "remove", account }, wasModalMenuOpen);
      case "signIn":
        return openDialog({ kind: "signIn", account }, wasModalMenuOpen);
      case "recoverFiles":
        return openDialog({ kind: "recoverFiles", account }, wasModalMenuOpen);
      case "manageAgents":
        return openDialog({ kind: "manageAgents", account }, wasModalMenuOpen);
      case "orchestratorOverride":
        return openDialog({ kind: "orchestratorOverride", account }, wasModalMenuOpen);
    }
  }

  const padding = compact ? space.lg : space.xxl;
  const gap = compact ? space.md : space.lg;
  const contentWidth = Math.min(Math.max(width - padding * 2, 0), 980);
  const menuBackdropInset = Math.max(padding, (width - contentWidth) / 2);
  const columns = contentWidth >= 820 ? 2 : 1;
  const cardWidth = columns === 2 ? (contentWidth - gap) / 2 : contentWidth;
  const profiles = data?.accounts.filter((account) => account.kind === "profile") ?? [];
  const fallback = data?.accounts.find((account) => account.id === data.defaultAccountId);
  const defaultUnavailable =
    fallback && fallback.kind === "profile" && (!fallback.usable || fallback.status === "signed-out");
  // An odd number of cards leaves room for the add tile beside the last one.
  const showAddTile = data !== undefined && (profiles.length === 0 || (columns === 2 && data.accounts.length % 2 === 1));

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding, alignItems: "center" }}>
        <View style={{ width: contentWidth || "100%", maxWidth: 980, gap: compact ? space.xxl : space.xxxl }}>
          {/* React Native Web gives this View its own stacking context. Keep the backdrop
              beside the account section so the account menu can layer above it. */}
          {openMenuId && !useModalMenu ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("dialog.close")}
              onPress={() => setOpenMenuId(null)}
              style={{
                position: "absolute",
                top: -padding,
                left: -menuBackdropInset,
                right: -menuBackdropInset,
                bottom: -padding,
                zIndex: 15,
              }}
            />
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? space.md : space.lg }}>
            <Avatar colors={colors} label="A" logo={antigravityLogoSvg("header")} size={compact ? 38 : 48} />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{ ...font.title, fontSize: compact ? 19 : font.title.fontSize, color: colors.foreground, flex: 1 }}
            >
              {t("title")}
            </Text>
            <Button
              colors={colors}
              variant="secondary"
              icon="RefreshCw"
              label={compact ? "" : t("refreshAll")}
              accessibilityLabel={t("refreshAll")}
              loading={refreshingAll}
              onPress={() => {
                setOpenMenuId(null);
                setRefreshingAll(true);
                void refresh({})
                  .then(accept)
                  .catch((reason: unknown) => toast.error(errorMessage(reason)))
                  .finally(() => setRefreshingAll(false));
              }}
            />
            <Button
              colors={colors}
              variant="primary"
              icon="Plus"
              label={compact ? "" : t("add")}
              accessibilityLabel={t("add")}
              onPress={() => {
                setOpenMenuId(null);
                setDialog({ kind: "add" });
              }}
            />
          </View>

          {error ? (
            <Callout
              colors={colors}
              tone="danger"
              icon="CircleAlert"
              title={error.message}
              action={<Button colors={colors} size="sm" label={t("retry")} onPress={() => void refetch()} />}
            />
          ) : null}
          {data && data.problems.length > 0 ? (
            <Callout colors={colors} tone="warning" icon="TriangleAlert" title={t("hostProblems")}>
              {data.problems.map((problem) => (
                <Muted key={problem} colors={colors}>
                  {problem}
                </Muted>
              ))}
            </Callout>
          ) : null}

          {contentWidth > 0 ? (
            <UsageSection colors={colors} width={contentWidth} compact={compact} accounts={data?.accounts ?? []} />
          ) : null}

          {!data && !error ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xl, alignSelf: "center" }}>
              <ActivityIndicator color={colors.accent} />
              <Muted colors={colors}>{t("loading")}</Muted>
            </View>
          ) : null}

          {data ? (
            <View style={{ gap: space.md, zIndex: openMenuId ? 20 : 0 }}>
              <SectionTitle colors={colors} title={t("accountsHeading")} count={data.accounts.length} />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
                {data.accounts.map((account, index) => {
                  const isOpen = openMenuId === account.id;
                  return (
                    <View
                      key={account.id}
                      style={{
                        width: cardWidth || "100%",
                        alignSelf: "stretch",
                        zIndex: isOpen ? 100 : data.accounts.length - index,
                      }}
                    >
                      <AccountCard
                        account={account}
                        colors={colors}
                        count={counts ? (counts.get(account.id) ?? 0) : undefined}
                        now={now}
                        busy={busy[account.id] ?? null}
                        compact={compact}
                        canMoveUp={index > 0}
                        canMoveDown={index < data.accounts.length - 1}
                        menuOpen={isOpen}
                        onToggleMenu={() => setOpenMenuId((current) => (current === account.id ? null : account.id))}
                        onAction={(action) => onAction(account, action)}
                      />
                    </View>
                  );
                })}
                {showAddTile ? (
                  <View style={{ width: cardWidth || "100%", alignSelf: "stretch" }}>
                    <AddAccountCard colors={colors} onAdd={() => setDialog({ kind: "add" })} />
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {data ? (
            <View style={{ gap: space.md }}>
              <SectionTitle colors={colors} title={t("settingsHeading")} />
              <SettingsCard>
                <SettingsSelect
                  label={t("overview.default")}
                  value={data.defaultAccountId}
                  options={data.accounts
                    .filter((account) => account.usable || account.id === data.defaultAccountId)
                    .map((account) => ({ value: account.id, label: displayLabel(account.label, t, account.kind) }))}
                  onValueChange={(accountId) => {
                    void setDefault({ accountId })
                      .then(accept)
                      .catch((reason: unknown) => toast.error(errorMessage(reason)));
                  }}
                />
                <SettingsSwitch
                  label={t("settings.fallback")}
                  value={data.fallback.enabled}
                  onValueChange={(enabled) => {
                    void setFallback({ enabled })
                      .then(accept)
                      .catch((reason: unknown) => toast.error(errorMessage(reason)));
                  }}
                />
                <SettingsSelect
                  label={t("settings.retries")}
                  disabled={!data.fallback.enabled}
                  value={String(data.fallback.retries)}
                  options={[0, 1, 2, 3].map((count) => ({
                    value: String(count),
                    label: count === 0 ? t("settings.retryNone") : t("settings.retryCount", { count }),
                  }))}
                  onValueChange={(value) => {
                    void setFallback({ retries: Number(value) })
                      .then(accept)
                      .catch((reason: unknown) => toast.error(errorMessage(reason)));
                  }}
                />
                <SettingsSelect
                  label={t("settings.strategy")}
                  disabled={!data.fallback.enabled}
                  value={data.fallback.strategy}
                  options={[
                    { value: "order", label: t("settings.strategyOrder") },
                    { value: "quota", label: t("settings.strategyQuota") },
                    { value: "reset", label: t("settings.strategyReset") },
                  ]}
                  onValueChange={(value) => {
                    void setFallback({ strategy: value as FallbackStrategy })
                      .then(accept)
                      .catch((reason: unknown) => toast.error(errorMessage(reason)));
                  }}
                />
                <OrchestratorRows colors={colors} accounts={data.accounts} onChange={(state) => observation.setOrchestrator(state)} />
                <SettingsRow label={t("overview.cli")} hint={data.agyPath ?? undefined}>
                  <Text style={{ ...font.small, color: data.agyPath ? colors.foreground : colors.statusWarning }}>
                    {data.agyPath ? t("overview.cliValue", { version: data.agyVersion ?? "?" }) : t("overview.cliMissing")}
                  </Text>
                </SettingsRow>
              </SettingsCard>
              {defaultUnavailable && fallback ? (
                <Callout
                  colors={colors}
                  tone="warning"
                  icon="TriangleAlert"
                  title={t("overview.defaultUnavailable", { label: displayLabel(fallback.label, t, fallback.kind) })}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>

      {dialog?.kind === "add" ? (
        <NameDialog
          colors={colors}
          title={t("dialog.addTitle")}
          initial=""
          confirmLabel={t("dialog.continue")}
          onClose={() => setDialog(null)}
          onSubmit={async (label) => {
            const result = await create({ label });
            accept(result.state);
            if (Platform.OS !== "web") {
              setDialog(null);
              openDialog({ kind: "signIn", account: result.account }, true);
            } else {
              setDialog({ kind: "signIn", account: result.account });
            }
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <NameDialog
          colors={colors}
          title={t("dialog.renameTitle")}
          initial={displayLabel(dialog.account.label, t, dialog.account.kind)}
          confirmLabel={t("dialog.save")}
          onClose={() => setDialog(null)}
          onSubmit={async (label) => {
            accept(await rename({ accountId: dialog.account.id, label }));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <ConfirmRemove
          colors={colors}
          accountId={dialog.account.id}
          label={displayLabel(dialog.account.label, t, dialog.account.kind)}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const { state, moved } = await remove({ accountId: dialog.account.id });
            accept(state);
            setDialog(null);
            if (moved) {
              toast.show(t("dialog.removedMoved", { count: moved.items.length, folder: moved.folder }), {
                variant: "success",
                durationMs: 8000,
              });
            }
          }}
        />
      ) : null}
      {dialog?.kind === "signIn" ? (
        <SignIn key={dialog.account.id} account={dialog.account} colors={colors} accept={accept} close={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "recoverFiles" ? (
        <RecoverFilesDialog colors={colors} account={dialog.account} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "manageAgents" && data ? (
        <AccountAgentsDialog
          colors={colors}
          account={dialog.account}
          accounts={data.accounts}
          agents={members.filter((member) => member.account === dialog.account.id)}
          onOpenAgent={
            navigation?.openAgent
              ? (agentId) => navigation.openAgent({ agentId, serverId: host.id })
              : undefined
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "orchestratorOverride" ? (
        <AccountOrchestratorDialog
          colors={colors}
          account={dialog.account}
          onSaved={(state) => {
            observation.setOrchestrator(state);
            void refetch();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </View>
  );
}
