import {
  useRpc,
  useTranslation,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useContext, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  AUTO_ACCOUNT_ID,
  SYSTEM_ACCOUNT_ID,
  refreshAccountsRpc,
  setDefaultAccountRpc,
  setRoutingRpc,
  type AccountSummary,
  type DefaultAccountId,
  type QuotaBucket,
  type QuotaGroup,
} from "../shared/contracts";
import { percent, relative } from "./format";
import { displayLabel } from "./labels";
import { antigravityLogoSvg } from "./logo";
import { errorMessage, messages } from "./messages";
import { bucketForWindow, groupForPool } from "./quota";
import { font, radius, remainingTone, space, tabular, tint, toneColor, type Colors } from "./theme";
import { Badge, Bar, Button, Divider, IconButton, Muted } from "./ui";
import { AccountsClientContext, useAccounts } from "./useAccounts";

// Geometry follows the other footer rows (host status, built-in usage summary).
const FONT_SIZE = 12;
const ICON_SIZE = 14;
const SIDEBAR_LOGO = { svg: antigravityLogoSvg("sidebar") };
const POPOVER_LOGO = { svg: antigravityLogoSvg("popover") };

function isWindowDisabled(group: QuotaGroup | null, window: string): boolean {
  if (!group) return false;
  const matching = group.buckets.filter((bucket) => bucket.window.trim().toLowerCase() === window);
  return matching.length > 0 && matching.every((bucket) => bucket.disabled);
}

function Meter({ colors, label, bucket, locale }: { colors: Colors; label: string; bucket: QuotaBucket | null; locale: string }) {
  const fraction = bucket?.remainingFraction ?? null;
  const tone = remainingTone(fraction);
  const warn = tone === "warning" || tone === "danger";
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: FONT_SIZE, fontWeight: "600", color: colors.foregroundMuted }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 16 }}>
        <Bar colors={colors} fraction={fraction ?? 0} tone={fraction === null ? "neutral" : tone} height={6} />
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontSize: FONT_SIZE,
          ...tabular,
          width: 34,
          textAlign: "right",
          color: warn ? (tone === "danger" ? colors.statusDanger : colors.statusWarning) : colors.foreground,
        }}
      >
        {fraction === null ? "—" : percent(fraction, locale)}
      </Text>
    </View>
  );
}

function PopoverMeter({
  colors,
  label,
  bucket,
  now,
  locale,
}: {
  colors: Colors;
  label: string;
  bucket: QuotaBucket | null;
  now: number;
  locale: string;
}) {
  const { t } = useTranslation(messages);
  const fraction = bucket?.remainingFraction ?? null;
  const tone = remainingTone(fraction);
  const warn = tone === "warning" || tone === "danger";
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
        <Text style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted }}>{label}</Text>
        <View style={{ flex: 1 }} />
        <Text
          numberOfLines={1}
          style={{
            ...font.caption,
            ...tabular,
            fontWeight: "600",
            color: warn ? toneColor(colors, tone) : colors.foreground,
          }}
        >
          {fraction === null ? "—" : percent(fraction, locale)}
        </Text>
      </View>
      <Bar colors={colors} fraction={fraction ?? 0} tone={fraction === null ? "neutral" : tone} height={5} />
      <Text numberOfLines={1} style={{ fontSize: 11, lineHeight: 14, color: colors.foregroundMuted }}>
        {bucket?.resetTime
          ? Date.parse(bucket.resetTime) <= now
            ? t("resetting")
            : t("resets", { time: relative(bucket.resetTime, now, locale) })
          : "\u00a0"}
      </Text>
    </View>
  );
}

function PopoverAccountRow({
  account,
  colors,
  isSelectedDefault,
  isResolvedAuto,
  isWeightedRouting,
  now,
  locale,
  busy,
  onSelectDefault,
}: {
  account: AccountSummary;
  colors: Colors;
  isSelectedDefault: boolean;
  isResolvedAuto: boolean;
  isWeightedRouting: boolean;
  now: number;
  locale: string;
  busy: boolean;
  onSelectDefault(): void;
}) {
  const { t } = useTranslation(messages);
  const name = displayLabel(account.label, t, account.kind);
  const group = groupForPool(account.quota, "gemini");
  const fiveHour = bucketForWindow(group, "5h");
  const weekly = bucketForWindow(group, "weekly");
  const activeCooldowns = account.cooldowns.filter((entry) => Date.parse(entry.until) > now);
  const geminiCooling = activeCooldowns.some((entry) => entry.pool === "all" || entry.pool === "gemini");
  const signedIn = account.status === "signed-in";
  const shareLabel =
    isWeightedRouting && account.routingShare !== null && account.effectiveWeight > 0
      ? `~${percent(account.routingShare, locale)}`
      : null;

  return (
    <View
      style={{
        padding: space.sm + 2,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: isSelectedDefault || isResolvedAuto ? tint(colors.accent, 0.45) : colors.border,
        backgroundColor: isSelectedDefault || isResolvedAuto ? tint(colors.accent, 0.05) : colors.surface1,
        gap: space.xs + 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: !account.usable
              ? colors.statusWarning
              : signedIn
                ? geminiCooling
                  ? colors.statusWarning
                  : colors.statusSuccess
                : colors.foregroundMuted,
          }}
        />
        <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
          {name}
        </Text>
        {account.note ? (
          <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted, flexShrink: 2 }}>
            · {account.note}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {shareLabel ? (
          <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
            {shareLabel}
          </Text>
        ) : null}
        {isResolvedAuto ? (
          <Badge colors={colors} label={t("auto.badge")} tone="accent" />
        ) : isSelectedDefault ? (
          <Badge colors={colors} label={t("badgeDefault")} tone="accent" icon="Star" />
        ) : account.usable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("action.makeDefault")}
            disabled={busy}
            onPress={onSelectDefault}
            style={(state) => ({
              paddingHorizontal: space.xs + 2,
              height: 22,
              borderRadius: radius.pill,
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              backgroundColor:
                (state as { hovered?: boolean }).hovered || state.pressed
                  ? tint(colors.foreground, 0.08)
                  : tint(colors.foreground, 0.04),
              opacity: busy ? 0.5 : 1,
            })}
          >
            <Icon name="Star" size={11} color={colors.foregroundMuted} />
            <Text style={{ fontSize: 11, fontWeight: "500", color: colors.foregroundMuted }}>
              {t("sidebar.setDefault")}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {signedIn && group ? (
        <View style={{ flexDirection: "row", gap: space.md }}>
          <PopoverMeter colors={colors} label="5H" bucket={fiveHour} now={now} locale={locale} />
          <PopoverMeter colors={colors} label="7D" bucket={weekly} now={now} locale={locale} />
        </View>
      ) : (
        <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
          {!account.usable ? t("callout.unusableTitle") : t(`status.${account.status}`)}
        </Text>
      )}
      {activeCooldowns.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {activeCooldowns.map((entry) => (
            <Badge
              key={entry.pool}
              colors={colors}
              tone="warning"
              icon="Clock"
              label={t("badgeCooldown", {
                pool: t(`cooldownPool.${entry.pool}`),
                time: relative(entry.until, now, locale),
              })}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Quick multi-account quota & default-switcher popover anchored to the sidebar footer row. */
function QuotaPopover({ theme, layout, close, openScreen }: PluginPopoverProps) {
  const { colors } = theme;
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const { data, accept } = useAccounts();
  const refresh = useRpc(refreshAccountsRpc);
  const setDefault = useRpc(setDefaultAccountRpc);
  const setRouting = useRpc(setRoutingRpc);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const accounts = data?.accounts ?? [];
  const signedInCount = accounts.filter((entry) => entry.usable && entry.status === "signed-in").length;
  const isWeightedRouting = data ? data.routing.mode !== "default" : false;
  const isAutoDefault = data?.defaultAccountId === AUTO_ACCOUNT_ID;
  const isAuto = isWeightedRouting || isAutoDefault;

  async function chooseDefault(accountId: DefaultAccountId) {
    if (switching) return;
    setSwitching(true);
    try {
      accept(await setDefault({ accountId }));
    } catch (reason) {
      toast.error(errorMessage(reason));
    } finally {
      setSwitching(false);
    }
  }

  async function toggleAutoRouting() {
    if (switching || !data) return;
    setSwitching(true);
    try {
      if (isAuto) {
        if (isWeightedRouting) {
          accept(await setRouting({ mode: "default" }));
        }
        if (isAutoDefault) {
          const fallbackTarget: DefaultAccountId =
            data.resolvedDefaultAccountId ??
            accounts.find((entry) => entry.usable && entry.status === "signed-in")?.id ??
            accounts.find((entry) => entry.usable)?.id ??
            SYSTEM_ACCOUNT_ID;
          accept(await setDefault({ accountId: fallbackTarget }));
        }
      } else {
        accept(await setRouting({ mode: "balanced" }));
      }
    } catch (reason) {
      toast.error(errorMessage(reason));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <View style={{ width: layout.compact ? "100%" : 344, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon icon={POPOVER_LOGO} size={18} color={colors.foreground} />
        <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flex: 1 }}>
          {t("title")}
        </Text>
        <IconButton
          colors={colors}
          icon="RefreshCw"
          label={t("refreshAll")}
          loading={refreshing}
          onPress={() => {
            setRefreshing(true);
            void refresh({})
              .then(accept)
              .catch((reason: unknown) => toast.error(errorMessage(reason)))
              .finally(() => setRefreshing(false));
          }}
        />
        <Button
          colors={colors}
          size="sm"
          variant="secondary"
          icon="ExternalLink"
          label={t("sidebar.openConsole")}
          onPress={() => {
            close();
            openScreen({ screenId: "accounts" });
          }}
        />
      </View>

      {data ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Muted colors={colors} small>
            {t("sidebar.signedInSummary", { signedIn: signedInCount, total: accounts.length })}
          </Muted>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            disabled={switching}
            onPress={() => void toggleAutoRouting()}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              height: 24,
              paddingHorizontal: space.sm,
              borderRadius: radius.pill,
              backgroundColor: isAuto
                ? tint(colors.accent, 0.16)
                : (state as { hovered?: boolean }).hovered
                  ? tint(colors.foreground, 0.08)
                  : tint(colors.foreground, 0.05),
              opacity: switching ? 0.6 : 1,
            })}
          >
            <Icon name={isWeightedRouting ? "Gauge" : "Sparkles"} size={12} color={isAuto ? colors.accent : colors.foregroundMuted} />
            <Text style={{ ...font.caption, fontWeight: "500", color: isAuto ? colors.accent : colors.foregroundMuted }}>
              {isAuto ? t("sidebar.autoOn") : t("sidebar.autoOff")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <Divider colors={colors} />

      {accounts.length === 0 ? (
        <Muted colors={colors}>{t("loading")}</Muted>
      ) : (
        <ScrollView style={{ maxHeight: layout.compact ? 420 : 340 }} contentContainerStyle={{ gap: space.sm }}>
          {accounts.map((account) => (
            <PopoverAccountRow
              key={account.id}
              account={account}
              colors={colors}
              isSelectedDefault={!isAutoDefault && data?.defaultAccountId === account.id}
              isResolvedAuto={isAutoDefault && data?.resolvedDefaultAccountId === account.id}
              isWeightedRouting={isWeightedRouting}
              now={now}
              locale={locale}
              busy={switching}
              onSelectDefault={() => void chooseDefault(account.id)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Footer row: the active default account's 5-hour and weekly quota left; opens quick popover. */
export function QuotaSidebarItem({ theme, currentScreen, openPopover }: PluginSidebarItemProps) {
  const { colors } = theme;
  const { t, locale } = useTranslation(messages);
  const { data } = useAccounts();
  const client = useContext(AccountsClientContext);

  const BoundPopover = useMemo(
    () =>
      function BoundQuotaPopover(props: PluginPopoverProps) {
        return (
          <AccountsClientContext.Provider value={client}>
            <QuotaPopover {...props} />
          </AccountsClientContext.Provider>
        );
      },
    [client],
  );

  const activeId =
    data?.resolvedDefaultAccountId ??
    (data && data.defaultAccountId !== AUTO_ACCOUNT_ID ? data.defaultAccountId : null);
  const account = activeId ? data?.accounts.find((entry) => entry.id === activeId) : undefined;
  const group = account?.quota ? groupForPool(account.quota, "gemini") : null;
  const fiveHour = bucketForWindow(group, "5h");
  const weekly = bucketForWindow(group, "weekly");
  const fiveHourDisabled = isWindowDisabled(group, "5h");
  const weeklyDisabled = isWindowDisabled(group, "weekly");
  const hideFiveHour = fiveHourDisabled && !fiveHour && Boolean(weekly || !weeklyDisabled);
  const hideWeekly = weeklyDisabled && !weekly && Boolean(fiveHour);
  const accountUnhealthy = Boolean(account && (!account.usable || account.status === "signed-out"));
  const active = currentScreen?.screenId === "accounts";
  const describe = (bucket: QuotaBucket | null, disabled: boolean) =>
    disabled
      ? t("off")
      : bucket?.remainingFraction === null || bucket?.remainingFraction === undefined
        ? "—"
        : percent(bucket.remainingFraction, locale);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.label", {
        fiveHour: describe(fiveHour, fiveHourDisabled),
        weekly: describe(weekly, weeklyDisabled),
      })}
      onPress={() => openPopover(BoundPopover)}
      style={(state) => ({
        width: "100%",
        minHeight: 28,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: active
          ? colors.surface2
          : (state as { hovered?: boolean }).hovered || state.pressed
            ? tint(colors.foreground, 0.05)
            : "transparent",
      })}
    >
      {accountUnhealthy ? (
        <Icon name="AlertTriangle" size={ICON_SIZE} color={colors.statusWarning} />
      ) : (
        <Icon icon={SIDEBAR_LOGO} size={ICON_SIZE} color={colors.foregroundMuted} />
      )}
      {!hideFiveHour ? <Meter colors={colors} label="5H" bucket={fiveHour} locale={locale} /> : null}
      {!hideWeekly ? <Meter colors={colors} label="7D" bucket={weekly} locale={locale} /> : null}
    </Pressable>
  );
}
