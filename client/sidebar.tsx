import { useTranslation, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { QuotaBucket, QuotaGroup } from "../shared/contracts";
import { percent } from "./format";
import { antigravityLogoSvg } from "./logo";
import { messages } from "./messages";
import { remainingTone, tabular, tint, type Colors } from "./theme";
import { Bar } from "./ui";
import { useAccounts } from "./useAccounts";

// Geometry follows the other footer rows (host status, built-in usage summary).
const FONT_SIZE = 12;
const ICON_SIZE = 14;
const SIDEBAR_LOGO = { svg: antigravityLogoSvg("sidebar") };

/** The quota group the sidebar summarizes: Gemini when present, else the first group. */
function primaryGroup(groups: readonly QuotaGroup[]): QuotaGroup | null {
  return groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? groups[0] ?? null;
}

function bucketFor(group: QuotaGroup | null, window: string): QuotaBucket | null {
  return group?.buckets.find((bucket) => bucket.window.trim().toLowerCase() === window && !bucket.disabled) ?? null;
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

function isWindowDisabled(group: QuotaGroup | null, window: string): boolean {
  if (!group) return false;
  const matching = group.buckets.filter((bucket) => bucket.window.trim().toLowerCase() === window);
  return matching.length > 0 && matching.every((bucket) => bucket.disabled);
}

/** Footer row: the default account's 5-hour and weekly quota left, as meters. */
export function QuotaSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { colors } = theme;
  const { t, locale } = useTranslation(messages);
  const { data } = useAccounts();
  const account = data?.accounts.find((entry) => entry.id === data.defaultAccountId);
  const group = account?.quota ? primaryGroup(account.quota) : null;
  const fiveHour = bucketFor(group, "5h");
  const weekly = bucketFor(group, "weekly");
  const fiveHourDisabled = isWindowDisabled(group, "5h");
  const weeklyDisabled = isWindowDisabled(group, "weekly");
  const hideFiveHour = fiveHourDisabled && !fiveHour && Boolean(weekly || !weeklyDisabled);
  const hideWeekly = weeklyDisabled && !weekly && Boolean(fiveHour);
  const accountUnhealthy = Boolean(account && (!account.usable || account.status === "signed-out"));
  const active = currentScreen?.screenId === "accounts";
  const describe = (bucket: QuotaBucket | null, disabled: boolean) =>
    disabled ? t("off") : bucket?.remainingFraction === null || bucket?.remainingFraction === undefined ? "—" : percent(bucket.remainingFraction, locale);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.label", {
        fiveHour: describe(fiveHour, fiveHourDisabled),
        weekly: describe(weekly, weeklyDisabled),
      })}
      onPress={() => openScreen({ screenId: "accounts" })}
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
