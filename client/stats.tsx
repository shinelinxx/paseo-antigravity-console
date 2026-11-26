import { useRpc, useTranslation, type PluginTranslations } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  UNATTRIBUTED_ACCOUNT_ID,
  usageStatsRpc,
  type AccountSummary,
  type StatsRange,
  type StatsScope,
  type UsageStats,
  type UsageTotals,
} from "../shared/contracts";
import { clockTime, dayLabel, integer, percent, tokens, usd, usdFixed, usdShort } from "./format";
import { ActivityCalendar } from "./heatmap";
import { displayLabel } from "./labels";
import { messages } from "./messages";
import { PricingDialog } from "./pricing";
import { font, radius, space, tabular, tint, type Colors } from "./theme";
import { Bar, Button, Card, Muted } from "./ui";

type PressState = { pressed: boolean; hovered?: boolean };
type ChartMetric = "tokens" | "cost" | "requests" | "tps" | "cache" | "firstToken";
type Resource = typeof messages extends PluginTranslations<infer R> ? R : never;
type Translate = ReturnType<typeof useTranslation<Resource>>["t"];

/** The figures the tiles show, in tile order; each tile selects its own series for the chart. */
const METRICS: readonly ChartMetric[] = ["tokens", "cost", "requests", "tps", "cache", "firstToken"];

const METRIC_LABEL = {
  tokens: "stats.tokens",
  cost: "stats.estimatedCost",
  requests: "stats.requests",
  tps: "stats.speed",
  cache: "stats.cache",
  firstToken: "stats.firstToken",
} as const;

/** Derived figures; null where the sums cannot support them. */
function derive(totals: UsageTotals) {
  const prompt = totals.input + totals.cached;
  return {
    requests: totals.requests,
    cost: totals.pricedRequests > 0 ? totals.cost : null,
    costPerRequest: totals.pricedRequests > 0 ? totals.cost / totals.pricedRequests : null,
    prompt,
    totalTokens: prompt + totals.output,
    tps: totals.generationSeconds > 0 ? totals.output / totals.generationSeconds : null,
    cacheRate: prompt > 0 ? totals.cached / prompt : null,
    firstToken: totals.requests > 0 ? totals.firstTokenSeconds / totals.requests : null,
    context: totals.requests > 0 ? prompt / totals.requests : null,
    output: totals.requests > 0 ? totals.output / totals.requests : null,
  };
}

function sumTotals(list: readonly UsageTotals[]): UsageTotals {
  const sum: UsageTotals = {
    requests: 0,
    input: 0,
    cached: 0,
    output: 0,
    generationSeconds: 0,
    firstTokenSeconds: 0,
    cost: 0,
    pricedRequests: 0,
  };
  for (const item of list) {
    sum.requests += item.requests;
    sum.input += item.input;
    sum.cached += item.cached;
    sum.output += item.output;
    sum.generationSeconds += item.generationSeconds;
    sum.firstTokenSeconds += item.firstTokenSeconds;
    sum.cost += item.cost;
    sum.pricedRequests += item.pricedRequests;
  }
  return sum;
}

function secondsLabel(value: number | null): string {
  if (value === null) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
}

/** One decimal everywhere, so a column of latencies lines up on the point. */
function secondsFixed(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} s`;
}

function tpsLabel(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

/** The smallest clean step at or above `value`; halves stay round. */
function niceCeiling(value: number, allowFraction = false): number {
  if (value <= 0) return allowFraction ? 1 : 2;
  if (allowFraction && value < 0.01) {
    const exp = Math.floor(Math.log10(value));
    const base = 10 ** exp;
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (step * base >= value) return step * base;
    }
    return 10 * base;
  }
  if (!allowFraction && value <= 2) return 2;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * base;
    if (candidate >= value && (allowFraction || Number.isInteger(candidate / 2))) return candidate;
  }
  return 10 * base;
}

function metricValue(bin: UsageTotals, metric: ChartMetric): number {
  const figures = derive(bin);
  switch (metric) {
    case "requests":
      return bin.requests;
    case "cost":
      return bin.cost;
    case "tokens":
      return figures.totalTokens;
    case "tps":
      return figures.tps ?? 0;
    case "cache":
      return figures.cacheRate ?? 0;
    case "firstToken":
      return figures.firstToken ?? 0;
  }
}

function formatAxisTick(value: number, metric: ChartMetric, locale: string): string {
  switch (metric) {
    case "requests":
      return integer(Math.round(value), locale);
    case "cost":
      return usdShort(value);
    case "tokens":
      return tokens(Math.round(value));
    case "tps":
      return String(Math.round(value));
    case "cache":
      return percent(value, locale);
    case "firstToken":
      return value === 0 ? "0" : `${value < 10 ? value.toFixed(1) : Math.round(value)}s`;
  }
}

/** A metric of one bin with its unit, as the chart's readout and tooltip show it. */
function metricText(bin: UsageTotals, metric: ChartMetric, locale: string, t: Translate): string {
  const figures = derive(bin);
  switch (metric) {
    case "tokens":
      return t("stats.readoutTokens", { value: tokens(figures.totalTokens) });
    case "cost":
      return figures.cost === null ? "—" : usd(figures.cost, locale);
    case "requests":
      return t("stats.readoutRequests", { count: bin.requests, value: integer(bin.requests, locale) });
    case "tps":
      return figures.tps === null ? "—" : t("stats.tps", { value: tpsLabel(figures.tps) });
    case "cache":
      return figures.cacheRate === null ? "—" : percent(figures.cacheRate, locale);
    case "firstToken":
      return secondsLabel(figures.firstToken);
  }
}

function SegmentedControl<T extends string>({
  colors,
  value,
  options,
  onChange,
}: {
  colors: Colors;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", flexWrap: "wrap", padding: 2, borderRadius: radius.md, backgroundColor: tint(colors.foreground, 0.06) }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={(state) => ({
              paddingHorizontal: space.md,
              height: 28,
              justifyContent: "center",
              borderRadius: radius.sm,
              backgroundColor: selected
                ? colors.surface0
                : (state as PressState).hovered
                  ? tint(colors.foreground, 0.05)
                  : "transparent",
              borderWidth: selected ? 1 : 0,
              borderColor: colors.border,
            })}
          >
            <Text style={{ ...font.small, fontWeight: selected ? "600" : "400", color: selected ? colors.foreground : colors.foregroundMuted }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Columns in the de-emphasis gray with the current bin in the accent. Zero draws nothing. */
const MiniColumns = memo(function MiniColumns({ colors, values }: { colors: Colors; values: ReadonlyArray<number | null> }) {
  const peak = Math.max(0, ...values.map((value) => value ?? 0));
  const last = values.length - 1;
  return (
    <View style={{ height: 26, flexDirection: "row", alignItems: "flex-end", gap: 2, borderBottomWidth: 1, borderBottomColor: tint(colors.foreground, 0.1) }}>
      {values.map((value, index) => (
        <View key={index} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
          {value && peak > 0 ? (
            <View
              style={{
                height: Math.max(2, (value / peak) * 24),
                borderTopLeftRadius: 2,
                borderTopRightRadius: 2,
                backgroundColor: index === last ? colors.accent : tint(colors.foreground, 0.2),
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
});

/** A figure that also selects the chart's series; the selected tile carries a heavier accent edge. */
const StatTile = memo(function StatTile({
  colors,
  label,
  value,
  unit,
  foot,
  width,
  compact = false,
  selected,
  onPress,
  children,
}: {
  colors: Colors;
  label: string;
  value: string;
  unit?: string;
  foot: string;
  width: number | "100%";
  compact?: boolean;
  selected: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  const edge = selected ? 2 : 1;
  const pad = (compact ? space.md : space.lg) - edge + 1;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ""}. ${foot}`}
      onPress={onPress}
      style={(state) => ({
        width,
        padding: pad,
        gap: space.xs,
        borderRadius: radius.lg,
        borderWidth: edge,
        borderColor: selected
          ? colors.accent
          : (state as PressState).hovered
            ? tint(colors.foreground, 0.24)
            : colors.border,
        backgroundColor: colors.surface1,
      })}
    >
      <Text numberOfLines={1} style={{ ...font.small, color: selected ? colors.foreground : colors.foregroundMuted }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
        {/* Proportional figures: tabular digits look loose at display sizes. */}
        <Text
          numberOfLines={1}
          style={{
            fontSize: compact ? 22 : 26,
            lineHeight: compact ? 28 : 32,
            fontWeight: "600",
            color: colors.foreground,
            flexShrink: 1,
          }}
        >
          {value}
        </Text>
        {unit ? <Text style={{ ...font.small, color: colors.foregroundMuted }}>{unit}</Text> : null}
      </View>
      <Text numberOfLines={2} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {foot}
      </Text>
      <View style={{ height: 26, justifyContent: "flex-end", marginTop: "auto", paddingTop: space.xs }}>{children}</View>
    </Pressable>
  );
});

function binLabel(start: number, end: number, binMs: number, locale: string): string {
  const day = dayLabel(new Date(start), locale);
  if (binMs >= 86_400_000) return day;
  const time = clockTime(start, locale);
  const endText = clockTime(end, locale);
  return `${day} ${time}–${endText}`;
}

function tickLabel(start: number, binMs: number, locale: string): string {
  if (binMs >= 86_400_000 || binMs >= 6 * 3_600_000) {
    return dayLabel(new Date(start), locale);
  }
  return clockTime(start, locale);
}

function showsTick(start: number, binMs: number, index: number, total: number, narrow: boolean): boolean {
  if (index <= 1 || index >= total - 2) return false;
  const date = new Date(start);
  if (binMs >= 86_400_000) return index % (narrow ? 8 : 5) === 0;
  if (binMs >= 6 * 3_600_000) {
    if (date.getHours() !== 0) return false;
    return !narrow || Math.floor(index / 4) % 2 === 1;
  }
  return date.getHours() % (narrow ? 8 : 6) === 0;
}

/** "Nov 23 00:00 – now" for hourly ranges, "Oct 25 – Nov 23" for days: the window the range covers. */
function windowText(stats: UsageStats, locale: string, t: Translate): string {
  const first = stats.bins[0];
  const last = stats.bins[stats.bins.length - 1];
  if (!first || !last) return "";
  if (stats.binMs >= 86_400_000) {
    return `${dayLabel(new Date(first.start), locale)} – ${dayLabel(new Date(last.end - 1), locale)}`;
  }
  return t("stats.windowSince", { start: `${dayLabel(new Date(first.start), locale)} ${clockTime(first.start, locale)}` });
}

const MetricChart = memo(function MetricChart({
  colors,
  stats,
  metric,
  locale,
  compact,
}: {
  colors: Colors;
  stats: UsageStats;
  metric: ChartMetric;
  locale: string;
  compact: boolean;
}) {
  const { t } = useTranslation(messages);
  const [hovered, setHovered] = useState<number | null>(null);
  const [pointer, setPointer] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const hoverPointer = useRef(false);
  const bins = stats.bins;

  useEffect(() => {
    hoverPointer.current = false;
    setHovered(null);
    setPointer(null);
  }, [stats.range, bins.length]);

  const lastActive = useMemo(() => {
    for (let index = bins.length - 1; index >= 0; index -= 1) if (bins[index]!.requests > 0) return index;
    return Math.max(0, bins.length - 1);
  }, [bins]);
  const selected = hovered !== null && hovered < bins.length ? hovered : lastActive;
  const rawValues = useMemo(() => bins.map((entry) => metricValue(entry, metric)), [bins, metric]);
  const peak = useMemo(() => {
    const maxVal = Math.max(0, ...rawValues);
    return metric === "cache" ? 1 : niceCeiling(maxVal, metric === "firstToken" || metric === "cost");
  }, [rawValues, metric]);
  const axisTicks = useMemo(
    () => [peak, peak / 2, 0].map((tick) => formatAxisTick(tick, metric, locale)),
    [peak, metric, locale],
  );
  const barLabels = useMemo(
    () =>
      bins.map(
        (entry) =>
          `${binLabel(entry.start, entry.end, stats.binMs, locale)}: ${
            entry.requests === 0 ? t("stats.noRequests") : metricText(entry, metric, locale, t)
          }`,
      ),
    [bins, stats.binMs, metric, locale, t],
  );
  const chartHeight = 140;
  const plotTop = 8;
  const plotHeight = chartHeight - plotTop - 4;
  const topLabel = axisTicks[0] ?? "";
  const axisWidth = Math.max(28, topLabel.length * 7.5);
  const bin = bins[selected];
  const periodKey = stats.binMs >= 86_400_000 ? "stats.perDay" : stats.binMs >= 6 * 3_600_000 ? "stats.perSixHours" : "stats.perHour";
  const columnWidth = bins.length > 0 ? plotWidth / bins.length : 0;
  const tooltipBin = pointer !== null ? bins[pointer] : undefined;
  const tooltipCenter = pointer === null ? 0 : (pointer + 0.5) * columnWidth;
  // Beside the bar, on the roomier side, when it fits; otherwise centered on the bar and kept inside the plot.
  const tooltipWidth = Math.min(210, plotWidth);
  const rightOfBar = tooltipCenter + columnWidth / 2 + 6;
  const leftOfBar = tooltipCenter - columnWidth / 2 - 6 - tooltipWidth;
  const fitsRight = rightOfBar + tooltipWidth <= plotWidth;
  const fitsLeft = leftOfBar >= 0;
  const centered = Math.min(Math.max(tooltipCenter - tooltipWidth / 2, 0), plotWidth - tooltipWidth);
  const tooltipLeft =
    tooltipCenter < plotWidth / 2
      ? fitsRight
        ? rightOfBar
        : fitsLeft
          ? leftOfBar
          : centered
      : fitsLeft
        ? leftOfBar
        : fitsRight
          ? rightOfBar
          : centered;

  return (
    <Card colors={colors} style={{ padding: space.lg }}>
      <Pressable
        accessible={false}
        focusable={false}
        onPress={() => {
          if (!hoverPointer.current) {
            setHovered(null);
            setPointer(null);
          }
        }}
        style={{ gap: space.md }}
      >
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "flex-start" : "baseline",
            gap: compact ? 2 : space.md,
          }}
        >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flex: compact ? undefined : 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
            {t(METRIC_LABEL[metric])}
          </Text>
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
            {t(periodKey)}
          </Text>
        </View>
        {bin ? (
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
            {`${binLabel(bin.start, bin.end, stats.binMs, locale)}   `}
            <Text style={{ color: colors.foreground, fontWeight: "600", ...tabular }}>
              {bin.requests === 0 ? t("stats.noRequests") : metricText(bin, metric, locale, t)}
            </Text>
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ width: axisWidth, height: chartHeight }}>
          {axisTicks.map((label, index) => (
            <Text
              key={index}
              style={{
                ...font.caption,
                ...tabular,
                color: colors.foregroundMuted,
                position: "absolute",
                right: 0,
                top: plotTop + (index * plotHeight) / 2 - 8,
                lineHeight: 16,
              }}
            >
              {label}
            </Text>
          ))}
        </View>
        <View style={{ flex: 1 }} onLayout={(event) => setPlotWidth(event.nativeEvent.layout.width)}>
          <View style={{ height: chartHeight }}>
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight / 2, height: 1, backgroundColor: tint(colors.foreground, 0.07) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotHeight, height: 1, backgroundColor: tint(colors.foreground, 0.18) }} />
            <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: chartHeight - plotTop - plotHeight, flexDirection: "row" }}>
              {bins.map((entry, index) => {
                const active = index === selected;
                const val = rawValues[index] ?? 0;
                const height = val > 0 && peak > 0 ? Math.max(3, Math.min(1, val / peak) * plotHeight) : 0;
                return (
                  <Pressable
                    key={entry.start}
                    accessibilityRole="button"
                    accessibilityLabel={barLabels[index]}
                    onHoverIn={() => {
                      hoverPointer.current = true;
                      setHovered(index);
                      setPointer(index);
                    }}
                    onHoverOut={() => {
                      hoverPointer.current = false;
                      setHovered((current) => (current === index ? null : current));
                      setPointer((current) => (current === index ? null : current));
                    }}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      if (hoverPointer.current) {
                        setHovered(index);
                        setPointer(index);
                        return;
                      }
                      setHovered((current) => (current === index ? null : index));
                      setPointer((current) => (current === index ? null : index));
                    }}
                    style={(state) => ({
                      flex: 1,
                      height: "100%",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      backgroundColor: (state as PressState).hovered ? tint(colors.foreground, 0.04) : "transparent",
                    })}
                  >
                    {height > 0 ? (
                      <View
                        style={{
                          width: "62%",
                          maxWidth: 24,
                          height,
                          borderTopLeftRadius: 4,
                          borderTopRightRadius: 4,
                          backgroundColor: active ? colors.accent : tint(colors.accent, 0.35),
                        }}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

          </View>
          <View style={{ flexDirection: "row", marginTop: space.xs, height: 16 }}>
            {bins.map((entry, index) => (
              <View key={entry.start} style={{ flex: 1, alignItems: "center" }}>
                {showsTick(entry.start, stats.binMs, index, bins.length, compact || (plotWidth > 0 && plotWidth < 420)) ? (
                  <View pointerEvents="none" style={{ position: "absolute", width: 76, alignItems: "center" }}>
                    <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                      {tickLabel(entry.start, stats.binMs, locale)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
            {tooltipBin && columnWidth > 0 ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  zIndex: 10,
                  top: 0,
                  left: tooltipLeft,
                  width: tooltipWidth,
                  padding: space.sm + 2,
                  gap: 3,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface0,
                  shadowColor: "#000",
                  shadowOpacity: 0.12,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 4,
                }}
              >
                <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted, marginBottom: 2 }}>
                  {binLabel(tooltipBin.start, tooltipBin.end, stats.binMs, locale)}
                </Text>
                {tooltipBin.requests === 0 ? (
                  <Text style={{ ...font.small, color: colors.foreground }}>{t("stats.noRequests")}</Text>
                ) : (
                  METRICS.map((item) => (
                    <View key={item} style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>
                        {t(METRIC_LABEL[item])}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{
                          ...font.caption,
                          ...tabular,
                          color: colors.foreground,
                          fontWeight: item === metric ? "700" : "500",
                        }}
                      >
                        {item === "requests"
                          ? integer(tooltipBin.requests, locale)
                          : item === "tokens"
                            ? tokens(derive(tooltipBin).totalTokens)
                            : metricText(tooltipBin, item, locale, t)}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            ) : null}
        </View>
      </View>
      </Pressable>
    </Card>
  );
});

type SortKey = "requests" | "tokens" | "cost" | "context" | "output" | "speed" | "cache" | "firstToken";
type ShareKey = "requests" | "tokens" | "cost";

function sortValue(figures: ReturnType<typeof derive>, key: SortKey): number | null {
  switch (key) {
    case "requests":
      return figures.requests;
    case "tokens":
      return figures.totalTokens;
    case "cost":
      return figures.cost;
    case "context":
      return figures.context;
    case "output":
      return figures.output;
    case "speed":
      return figures.tps;
    case "cache":
      return figures.cacheRate;
    case "firstToken":
      return figures.firstToken;
  }
}

function shareValue(figures: ReturnType<typeof derive>, key: ShareKey): number {
  if (key === "requests") return figures.requests;
  if (key === "cost") return figures.cost ?? 0;
  return figures.totalTokens;
}

const ModelTable = memo(function ModelTable({
  colors,
  stats,
  locale,
  wide,
  selectedModel,
  onSelectModel,
  onEditPricing,
}: {
  colors: Colors;
  stats: UsageStats;
  locale: string;
  wide: boolean;
  selectedModel: string | null;
  onSelectModel(model: string | null): void;
  onEditPricing(pricingKey: string): void;
}) {
  const { t } = useTranslation(messages);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "tokens", descending: true });
  // The share bar shows whichever additive column the table is sorted by; tokens otherwise.
  const shareKey: ShareKey = sort.key === "requests" || sort.key === "cost" ? sort.key : "tokens";
  const rows = useMemo(() => {
    const list = stats.models.map((model) => ({ model, figures: derive(model) }));
    list.sort((left, right) => {
      const a = sortValue(left.figures, sort.key);
      const b = sortValue(right.figures, sort.key);
      // Rows without the figure (an unpriced model's cost) always sit at the bottom.
      if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
      return sort.descending ? b - a : a - b;
    });
    return list;
  }, [stats.models, sort]);
  const totals = useMemo(() => derive(sumTotals(stats.models)), [stats.models]);
  const shareTotal = rows.reduce((sum, row) => sum + shareValue(row.figures, shareKey), 0);

  const columns: ReadonlyArray<{ key: SortKey; label: string; width: number }> = [
    { key: "requests", label: t("stats.col.requests"), width: 70 },
    { key: "tokens", label: t("stats.col.tokens"), width: 66 },
    { key: "cost", label: t("stats.col.cost"), width: 78 },
    { key: "context", label: t("stats.col.context"), width: 86 },
    { key: "output", label: t("stats.col.output"), width: 80 },
    { key: "speed", label: t("stats.col.speed"), width: 78 },
    { key: "cache", label: t("stats.col.cache"), width: 66 },
    { key: "firstToken", label: t("stats.col.firstToken"), width: 78 },
  ];

  const cellsOf = (figures: ReturnType<typeof derive>): Record<SortKey, string> => ({
    requests: integer(figures.requests, locale),
    tokens: tokens(figures.totalTokens),
    cost: figures.cost === null ? "—" : usdFixed(figures.cost, locale),
    context: figures.context === null ? "—" : tokens(Math.round(figures.context)),
    output: figures.output === null ? "—" : tokens(Math.round(figures.output)),
    speed: figures.tps === null ? "—" : t("stats.tps", { value: tpsLabel(figures.tps) }),
    cache: figures.cacheRate === null ? "—" : percent(figures.cacheRate, locale),
    firstToken: secondsFixed(figures.firstToken),
  });

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: true }));

  const rowFrame = {
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  } as const;

  /**
   * The model's name with a thin bar of its share laid under it. The bar sits outside the layout, so
   * the row stays one line and every figure shares the name's baseline.
   */
  const nameCell = (label: string, share: number | null) => (
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center", marginRight: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
          {label}
        </Text>
        <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {share === null ? "—" : share > 0 && share < 0.001 ? `<${percent(0.001, locale)}` : percent(share, locale)}
        </Text>
      </View>
      {/* Below one percent the bar would be a stray speck; the figure beside the name carries it. */}
      {share !== null && share >= 0.01 ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 6, height: 3 }}>
          <View
            style={{
              width: `${Math.min(1, share) * 100}%`,
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      ) : null}
    </View>
  );

  const costCell = (pricingKey: string, model: string, text: string, unpriced: boolean, width?: number) => (
    <Pressable
      key="cost"
      accessibilityRole="button"
      accessibilityLabel={t("pricing.editFor", { model })}
      hitSlop={6}
      onPress={(event) => {
        event.stopPropagation?.();
        onEditPricing(pricingKey);
      }}
      style={(state) => ({ width, alignItems: "flex-end", opacity: (state as PressState).hovered ? 0.7 : 1 })}
    >
      <Text numberOfLines={1} style={{ ...font.small, ...tabular, color: unpriced ? colors.statusWarning : colors.foreground }}>
        {text}
      </Text>
    </Pressable>
  );

  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm, rowGap: 2, marginBottom: space.xs }}>
        <Text style={{ ...font.heading, color: colors.foreground, flexGrow: 1 }}>{t("stats.models")}</Text>
        <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("stats.modelsHint")}</Text>
      </View>

      {wide ? (
        <View
          style={{
            ...rowFrame,
            flexDirection: "row",
            alignItems: "flex-end",
            paddingBottom: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            borderRadius: 0,
          }}
        >
          <Text style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>{t("stats.col.model")}</Text>
          {columns.map((column) => {
            const active = sort.key === column.key;
            return (
              <Pressable
                key={column.key}
                accessibilityRole="button"
                accessibilityLabel={t("stats.sortBy", { column: column.label })}
                accessibilityState={{ selected: active }}
                onPress={() => toggleSort(column.key)}
                style={(state) => ({
                  width: column.width,
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 2,
                  opacity: (state as PressState).hovered && !active ? 0.75 : 1,
                })}
              >
                {active ? <Icon name={sort.descending ? "ArrowDown" : "ArrowUp"} size={11} color={colors.foreground} /> : null}
                <Text
                  numberOfLines={1}
                  style={{ ...font.caption, color: active ? colors.foreground : colors.foregroundMuted, fontWeight: active ? "600" : "400" }}
                >
                  {column.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View>
        {rows.map(({ model, figures }, index) => {
          const share =
            shareKey === "cost" && figures.cost === null ? null : shareTotal > 0 ? shareValue(figures, shareKey) / shareTotal : 0;
          const active = selectedModel === model.label;
          const dimmed = selectedModel !== null && !active;
          const cells = cellsOf(figures);
          return (
            <Pressable
              key={model.label}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelectModel(active ? null : model.label)}
              style={(state) => ({
                ...rowFrame,
                minHeight: wide ? 44 : undefined,
                paddingVertical: wide ? 0 : space.sm,
                flexDirection: wide ? "row" : "column",
                alignItems: wide ? "center" : "stretch",
                gap: wide ? 0 : space.xs,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: tint(colors.foreground, 0.06),
                opacity: dimmed ? 0.5 : 1,
                backgroundColor: active
                  ? tint(colors.accent, 0.08)
                  : (state as PressState).hovered
                    ? tint(colors.foreground, 0.04)
                    : "transparent",
              })}
            >
              {wide ? (
                <>
                  {nameCell(model.label, share)}
                  {columns.map((column) =>
                    column.key === "cost" ? (
                      costCell(model.pricingKey, model.label, cells.cost, figures.cost === null, column.width)
                    ) : (
                      <Text
                        key={column.key}
                        numberOfLines={1}
                        style={{ ...font.small, ...tabular, color: colors.foreground, width: column.width, textAlign: "right" }}
                      >
                        {cells[column.key]}
                      </Text>
                    ),
                  )}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", minHeight: 42 }}>
                    {nameCell(model.label, share)}
                    <Text style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}>
                      {t("stats.readoutTokens", { value: cells.tokens })}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm }}>
                    <Muted colors={colors} small>
                      {t("stats.readoutRequests", { count: figures.requests, value: integer(figures.requests, locale) })}
                    </Muted>
                    {costCell(
                      model.pricingKey,
                      model.label,
                      figures.cost === null ? t("pricing.unpriced") : cells.cost,
                      figures.cost === null,
                    )}
                    <Muted colors={colors} small>
                      {[
                        `${t("stats.col.context")} ${cells.context}`,
                        `${t("stats.col.output")} ${cells.output}`,
                        cells.speed,
                        `${t("stats.col.cache")} ${cells.cache}`,
                        `${t("stats.col.firstToken")} ${cells.firstToken}`,
                      ].join(" · ")}
                    </Muted>
                  </View>
                </>
              )}
            </Pressable>
          );
        })}

        {rows.length > 1 ? (
          <View
            style={{
              ...rowFrame,
              flexDirection: wide ? "row" : "column",
              alignItems: wide ? "center" : "stretch",
              minHeight: wide ? 44 : undefined,
              paddingVertical: wide ? 0 : space.sm,
              gap: wide ? 0 : space.xs,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              borderRadius: 0,
            }}
          >
            {(() => {
              const cells = cellsOf(totals);
              const label = (
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground, flex: 1 }}>
                  {t("stats.col.total")}
                </Text>
              );
              return wide ? (
                <>
                  {label}
                  {columns.map((column) => (
                    <Text
                      key={column.key}
                      numberOfLines={1}
                      style={{
                        ...font.small,
                        ...tabular,
                        fontWeight: "600",
                        color: column.key === "cost" && totals.cost === null ? colors.statusWarning : colors.foreground,
                        width: column.width,
                        textAlign: "right",
                      }}
                    >
                      {cells[column.key]}
                    </Text>
                  ))}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    {label}
                    <Text style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}>
                      {t("stats.readoutTokens", { value: cells.tokens })}
                    </Text>
                  </View>
                  <Muted colors={colors} small>
                    {(totals.requests === 0
                      ? [t("stats.readoutRequests", { count: 0, value: integer(0, locale) })]
                      : [t("stats.readoutRequests", { count: totals.requests, value: integer(totals.requests, locale) }), cells.cost, cells.speed, `${t("stats.col.cache")} ${cells.cache}`]
                    ).join(" · ")}
                  </Muted>
                </>
              );
            })()}
          </View>
        ) : null}
      </View>
    </Card>
  );
});

interface AccountBreakdownRow extends UsageTotals {
  accountId: string;
  label: string;
  conversations: number;
}

const ZERO_TOTALS: UsageTotals = {
  requests: 0,
  input: 0,
  cached: 0,
  output: 0,
  generationSeconds: 0,
  firstTokenSeconds: 0,
  cost: 0,
  pricedRequests: 0,
};

const AccountTable = memo(function AccountTable({
  colors,
  rowsData,
  locale,
  wide,
  selectedAccountId,
  onSelectAccount,
}: {
  colors: Colors;
  rowsData: readonly AccountBreakdownRow[];
  locale: string;
  wide: boolean;
  selectedAccountId: string | null;
  onSelectAccount(accountId: string | null): void;
}) {
  const { t } = useTranslation(messages);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "tokens", descending: true });
  const shareKey: ShareKey = sort.key === "requests" || sort.key === "cost" ? sort.key : "tokens";
  const rows = useMemo(() => {
    const list = rowsData.map((account) => ({ account, figures: derive(account) }));
    list.sort((left, right) => {
      const a = sortValue(left.figures, sort.key);
      const b = sortValue(right.figures, sort.key);
      if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
      if (b !== a) return sort.descending ? b - a : a - b;
      if (left.account.accountId === UNATTRIBUTED_ACCOUNT_ID) return 1;
      if (right.account.accountId === UNATTRIBUTED_ACCOUNT_ID) return -1;
      return left.account.label.localeCompare(right.account.label);
    });
    return list;
  }, [rowsData, sort]);
  const totals = useMemo(() => derive(sumTotals(rowsData)), [rowsData]);
  const shareTotal = rows.reduce((sum, row) => sum + shareValue(row.figures, shareKey), 0);

  const columns: ReadonlyArray<{ key: SortKey; label: string; width: number }> = [
    { key: "requests", label: t("stats.col.requests"), width: 70 },
    { key: "tokens", label: t("stats.col.tokens"), width: 66 },
    { key: "cost", label: t("stats.col.cost"), width: 78 },
    { key: "context", label: t("stats.col.context"), width: 86 },
    { key: "output", label: t("stats.col.output"), width: 80 },
    { key: "speed", label: t("stats.col.speed"), width: 78 },
    { key: "cache", label: t("stats.col.cache"), width: 66 },
    { key: "firstToken", label: t("stats.col.firstToken"), width: 78 },
  ];

  const cellsOf = (figures: ReturnType<typeof derive>): Record<SortKey, string> => ({
    requests: integer(figures.requests, locale),
    tokens: tokens(figures.totalTokens),
    cost: figures.cost === null ? "—" : usdFixed(figures.cost, locale),
    context: figures.context === null ? "—" : tokens(Math.round(figures.context)),
    output: figures.output === null ? "—" : tokens(Math.round(figures.output)),
    speed: figures.tps === null ? "—" : t("stats.tps", { value: tpsLabel(figures.tps) }),
    cache: figures.cacheRate === null ? "—" : percent(figures.cacheRate, locale),
    firstToken: secondsFixed(figures.firstToken),
  });

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: true }));

  const rowFrame = {
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  } as const;

  const nameCell = (label: string, share: number | null) => (
    <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center", marginRight: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
          {label}
        </Text>
        <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {share === null ? "—" : share > 0 && share < 0.001 ? `<${percent(0.001, locale)}` : percent(share, locale)}
        </Text>
      </View>
      {share !== null && share >= 0.01 ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 6, height: 3 }}>
          <View
            style={{
              width: `${Math.min(1, share) * 100}%`,
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <Card colors={colors} style={{ padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm, rowGap: 2, marginBottom: space.xs }}>
        <Text style={{ ...font.heading, color: colors.foreground, flexGrow: 1 }}>{t("stats.accountsTable")}</Text>
        <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("stats.accountsHint")}</Text>
      </View>

      {wide ? (
        <View
          style={{
            ...rowFrame,
            flexDirection: "row",
            alignItems: "flex-end",
            paddingBottom: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            borderRadius: 0,
          }}
        >
          <Text style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>{t("stats.colAccount")}</Text>
          {columns.map((column) => {
            const active = sort.key === column.key;
            return (
              <Pressable
                key={column.key}
                accessibilityRole="button"
                accessibilityLabel={t("stats.sortBy", { column: column.label })}
                accessibilityState={{ selected: active }}
                onPress={() => toggleSort(column.key)}
                style={(state) => ({
                  width: column.width,
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 2,
                  opacity: (state as PressState).hovered && !active ? 0.75 : 1,
                })}
              >
                {active ? <Icon name={sort.descending ? "ArrowDown" : "ArrowUp"} size={11} color={colors.foreground} /> : null}
                <Text
                  numberOfLines={1}
                  style={{ ...font.caption, color: active ? colors.foreground : colors.foregroundMuted, fontWeight: active ? "600" : "400" }}
                >
                  {column.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View>
        {rows.map(({ account, figures }, index) => {
          const share =
            shareKey === "cost" && figures.cost === null ? null : shareTotal > 0 ? shareValue(figures, shareKey) / shareTotal : 0;
          const active = selectedAccountId === account.accountId;
          const dimmed = selectedAccountId !== null && !active;
          const cells = cellsOf(figures);
          return (
            <Pressable
              key={account.accountId}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelectAccount(active ? null : account.accountId)}
              style={(state) => ({
                ...rowFrame,
                minHeight: wide ? 44 : undefined,
                paddingVertical: wide ? 0 : space.sm,
                flexDirection: wide ? "row" : "column",
                alignItems: wide ? "center" : "stretch",
                gap: wide ? 0 : space.xs,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: tint(colors.foreground, 0.06),
                opacity: dimmed ? 0.5 : 1,
                backgroundColor: active
                  ? tint(colors.accent, 0.08)
                  : (state as PressState).hovered
                    ? tint(colors.foreground, 0.04)
                    : "transparent",
              })}
            >
              {wide ? (
                <>
                  {nameCell(account.label, share)}
                  {columns.map((column) => (
                    <Text
                      key={column.key}
                      numberOfLines={1}
                      style={{ ...font.small, ...tabular, color: colors.foreground, width: column.width, textAlign: "right" }}
                    >
                      {cells[column.key]}
                    </Text>
                  ))}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", minHeight: 42 }}>
                    {nameCell(account.label, share)}
                    <Text style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}>
                      {t("stats.readoutTokens", { value: cells.tokens })}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm }}>
                    <Muted colors={colors} small>
                      {(figures.requests === 0
                        ? [t("stats.readoutRequests", { count: 0, value: integer(0, locale) })]
                        : [
                            t("stats.readoutRequests", { count: figures.requests, value: integer(figures.requests, locale) }),
                            cells.cost,
                            cells.speed,
                            `${t("stats.col.cache")} ${cells.cache}`,
                          ]
                      ).join(" · ")}
                    </Muted>
                  </View>
                </>
              )}
            </Pressable>
          );
        })}

        {rows.length > 1 ? (
          <View
            style={{
              ...rowFrame,
              flexDirection: wide ? "row" : "column",
              alignItems: wide ? "center" : "stretch",
              minHeight: wide ? 44 : undefined,
              paddingVertical: wide ? 0 : space.sm,
              gap: wide ? 0 : space.xs,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              borderRadius: 0,
            }}
          >
            {(() => {
              const cells = cellsOf(totals);
              const label = (
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground, flex: 1 }}>
                  {t("stats.col.total")}
                </Text>
              );
              return wide ? (
                <>
                  {label}
                  {columns.map((column) => (
                    <Text
                      key={column.key}
                      numberOfLines={1}
                      style={{
                        ...font.small,
                        ...tabular,
                        fontWeight: "600",
                        color: column.key === "cost" && totals.cost === null ? colors.statusWarning : colors.foreground,
                        width: column.width,
                        textAlign: "right",
                      }}
                    >
                      {cells[column.key]}
                    </Text>
                  ))}
                </>
              ) : (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    {label}
                    <Text style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}>
                      {t("stats.readoutTokens", { value: cells.tokens })}
                    </Text>
                  </View>
                  <Muted colors={colors} small>
                    {(totals.requests === 0
                      ? [t("stats.readoutRequests", { count: 0, value: integer(0, locale) })]
                      : [t("stats.readoutRequests", { count: totals.requests, value: integer(totals.requests, locale) }), cells.cost, cells.speed, `${t("stats.col.cache")} ${cells.cache}`]
                    ).join(" · ")}
                  </Muted>
                </>
              );
            })()}
          </View>
        ) : null}
      </View>
    </Card>
  );
});

export const UsageSection = memo(function UsageSection({
  colors,
  width,
  compact,
  accounts,
}: {
  colors: Colors;
  width: number;
  compact: boolean;
  accounts: readonly AccountSummary[];
}) {
  const { t, locale } = useTranslation(messages);
  const [range, setRange] = useState<StatsRange>("24h");
  const [scope, setScope] = useState<StatsScope>("all");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [pricingOpen, setPricingOpen] = useState<{ open: boolean; focusKey?: string | null }>({ open: false });
  const read = useRpc(usageStatsRpc);
  const query = useQuery({
    queryKey: ["antigravity-accounts", "stats", range, scope, accountId ?? "", selectedModel ?? ""],
    queryFn: () =>
      read({
        range,
        scope,
        ...(accountId ? { accountId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
      }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    // Keep the last figures on screen while a new range or filter loads, instead of flashing empty tiles.
    placeholderData: (previous) => previous,
  });
  const stats = query.data;
  const gap = compact ? space.md : space.lg;
  // The console caps its content at 980 points, so six tiles never fit in one row.
  const columns = width >= 600 ? 3 : 2;
  const tileWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const totals = useMemo(() => (stats ? derive(stats.totals) : null), [stats]);
  const sparklines = useMemo(() => {
    if (!stats) {
      return {
        tokens: [] as Array<number | null>,
        cost: [] as Array<number | null>,
        requests: [] as Array<number | null>,
        tps: [] as Array<number | null>,
        firstToken: [] as Array<number | null>,
      };
    }
    const tokensSeries: number[] = [];
    const costSeries: number[] = [];
    const requestsSeries: number[] = [];
    const tpsSeries: Array<number | null> = [];
    const firstTokenSeries: Array<number | null> = [];
    for (const bin of stats.bins) {
      const figures = derive(bin);
      tokensSeries.push(figures.totalTokens);
      costSeries.push(bin.cost);
      requestsSeries.push(bin.requests);
      tpsSeries.push(figures.tps);
      firstTokenSeries.push(figures.firstToken);
    }
    return {
      tokens: tokensSeries,
      cost: costSeries,
      requests: requestsSeries,
      tps: tpsSeries,
      firstToken: firstTokenSeries,
    };
  }, [stats]);
  const handleSelectAccount = useCallback((next: string | null) => {
    setAccountId(next);
    setSelectedModel(null);
  }, []);
  const handleEditPricing = useCallback((pricingKey: string) => {
    setPricingOpen({ open: true, focusKey: pricingKey });
  }, []);
  const hasSubagents = (stats?.breakdown.subagent.requests ?? 0) > 0;
  const accountKindById = useMemo(() => new Map(accounts.map((a) => [a.id, a.kind])), [accounts]);
  const accountEntries = useMemo<AccountBreakdownRow[]>(() => {
    const byId = new Map((stats?.accounts ?? []).map((entry) => [entry.accountId, entry]));
    const rows: AccountBreakdownRow[] = [];
    const seen = new Set<string>();
    for (const account of accounts) {
      seen.add(account.id);
      const found = byId.get(account.id);
      rows.push({
        ...(found ?? { ...ZERO_TOTALS, conversations: 0 }),
        accountId: account.id,
        label: displayLabel(account.label, t, account.kind),
      });
    }
    for (const entry of stats?.accounts ?? []) {
      if (seen.has(entry.accountId)) continue;
      seen.add(entry.accountId);
      rows.push({
        ...entry,
        label:
          entry.accountId === UNATTRIBUTED_ACCOUNT_ID
            ? t("stats.accountUnattributed")
            : displayLabel(entry.label, t, accountKindById.get(entry.accountId)),
      });
    }
    return rows;
  }, [accounts, stats?.accounts, accountKindById, t]);
  const showAccountControls = accounts.length > 1 || accountEntries.length > 1;
  const unpriced = stats ? stats.totals.requests - stats.totals.pricedRequests : 0;
  const tile = (key: ChartMetric) => ({
    colors,
    width: tileWidth,
    compact,
    label: t(METRIC_LABEL[key]),
    selected: metric === key,
    onPress: () => setMetric(key),
  });

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Text style={{ ...font.heading, color: colors.foreground, flex: 1, minWidth: 80 }}>{t("stats.title")}</Text>
        <Button
          colors={colors}
          size="sm"
          variant="secondary"
          icon="DollarSign"
          label={compact ? "" : t("pricing.button")}
          accessibilityLabel={t("pricing.button")}
          onPress={() => setPricingOpen({ open: true, focusKey: null })}
        />
        {hasSubagents || scope !== "all" ? (
          <SegmentedControl<StatsScope>
            colors={colors}
            value={scope}
            options={[
              { value: "all", label: t("stats.scope.all") },
              { value: "main", label: t("stats.scope.main") },
              { value: "subagent", label: t("stats.scope.subagent") },
            ]}
            onChange={(next) => {
              setScope(next);
              setSelectedModel(null);
            }}
          />
        ) : null}
      </View>

      {showAccountControls || accountId !== null || selectedModel ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
          {showAccountControls ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setAccountId(null);
                  setSelectedModel(null);
                }}
                style={{
                  paddingHorizontal: space.sm + 2,
                  height: 26,
                  borderRadius: radius.pill,
                  justifyContent: "center",
                  backgroundColor: accountId === null ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
                }}
              >
                <Text style={{ ...font.caption, fontWeight: "500", color: accountId === null ? colors.accent : colors.foregroundMuted }}>
                  {t("stats.accountAll")}
                </Text>
              </Pressable>
              {accountEntries.map((chip) => {
                const active = accountId === chip.accountId;
                const costSuffix = chip.pricedRequests > 0 ? ` · ${usd(chip.cost, locale)}` : "";
                return (
                  <Pressable
                    key={chip.accountId}
                    accessibilityRole="button"
                    onPress={() => {
                      setAccountId(active ? null : chip.accountId);
                      setSelectedModel(null);
                    }}
                    style={{
                      paddingHorizontal: space.sm + 2,
                      height: 26,
                      borderRadius: radius.pill,
                      justifyContent: "center",
                      backgroundColor: active ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
                    }}
                  >
                    <Text style={{ ...font.caption, ...tabular, fontWeight: "500", color: active ? colors.accent : colors.foregroundMuted }}>
                      {`${chip.label} · ${integer(chip.requests, locale)}${costSuffix}`}
                    </Text>
                  </Pressable>
                );
              })}
            </>
          ) : accountId !== null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setAccountId(null);
                setSelectedModel(null);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.sm + 2,
                height: 26,
                borderRadius: radius.pill,
                backgroundColor: tint(colors.accent, 0.16),
              }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {accountId === UNATTRIBUTED_ACCOUNT_ID
                  ? t("stats.accountUnattributed")
                  : (() => {
                      const matched = accounts.find((entry) => entry.id === accountId);
                      return matched ? displayLabel(matched.label, t, matched.kind) : accountId;
                    })()}
              </Text>
              <Icon name="X" size={12} color={colors.accent} />
            </Pressable>
          ) : null}

          {selectedModel ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelectedModel(null)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.sm + 2,
                height: 26,
                borderRadius: radius.pill,
                backgroundColor: tint(colors.accent, 0.16),
              }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {t("stats.filterModel", { model: selectedModel })}
              </Text>
              <Icon name="X" size={12} color={colors.accent} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {query.error ? <Muted colors={colors}>{(query.error as Error).message}</Muted> : null}

      <ActivityCalendar
        colors={colors}
        width={width}
        compact={compact}
        scope={scope}
        accountId={accountId}
        model={selectedModel}
      />

      {/* The range scopes everything below it; the calendar above always covers a year. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
        <Text numberOfLines={1} style={{ ...font.small, ...tabular, color: colors.foregroundMuted, flex: 1, minWidth: 120 }}>
          {stats ? windowText(stats, locale, t) : ""}
        </Text>
        <SegmentedControl<StatsRange>
          colors={colors}
          value={range}
          options={[
            { value: "24h", label: t("stats.range.24h") },
            { value: "7d", label: t("stats.range.7d") },
            { value: "30d", label: t("stats.range.30d") },
          ]}
          onChange={setRange}
        />
      </View>

      <View style={{ gap: space.md, opacity: query.isPlaceholderData ? 0.6 : 1 }}>
        <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
          <StatTile
            {...tile("tokens")}
            value={totals ? tokens(totals.totalTokens) : "—"}
            foot={totals ? t("stats.tokensSplit", { input: tokens(totals.prompt), output: tokens(stats!.totals.output) }) : " "}
          >
            <MiniColumns colors={colors} values={sparklines.tokens} />
          </StatTile>
          <StatTile
            {...tile("cost")}
            value={totals?.cost !== null && totals?.cost !== undefined ? usd(totals.cost, locale) : "—"}
            foot={
              totals?.costPerRequest !== null && totals?.costPerRequest !== undefined
                ? unpriced > 0
                  ? t("stats.costWithUnpriced", { avg: usd(totals.costPerRequest, locale), unpriced })
                  : stats?.hasCustomPricing
                    ? t("stats.costAvgCustom", { avg: usd(totals.costPerRequest, locale) })
                    : t("stats.costAvg", { avg: usd(totals.costPerRequest, locale) })
                : " "
            }
          >
            <MiniColumns colors={colors} values={sparklines.cost} />
          </StatTile>
          <StatTile
            {...tile("requests")}
            value={totals ? integer(totals.requests, locale) : "—"}
            foot={
              stats
                ? hasSubagents && scope === "all" && !selectedModel
                  ? t("stats.splitSummary", {
                      main: integer(stats.breakdown.main.requests, locale),
                      subagent: integer(stats.breakdown.subagent.requests, locale),
                    })
                  : t("stats.conversations", { count: stats.conversations, value: integer(stats.conversations, locale) })
                : " "
            }
          >
            <MiniColumns colors={colors} values={sparklines.requests} />
          </StatTile>
          <StatTile
            {...tile("tps")}
            value={tpsLabel(totals?.tps ?? null)}
            unit="tok/s"
            foot={totals?.output !== null && totals?.output !== undefined ? t("stats.avgOutput", { value: tokens(Math.round(totals.output)) }) : " "}
          >
            <MiniColumns colors={colors} values={sparklines.tps} />
          </StatTile>
          <StatTile
            {...tile("cache")}
            value={totals?.cacheRate !== null && totals?.cacheRate !== undefined ? percent(totals.cacheRate, locale) : "—"}
            foot={stats ? t("stats.cachedTokens", { value: tokens(stats.totals.cached) }) : " "}
          >
            <View style={{ paddingBottom: 4 }}>
              <Bar colors={colors} fraction={totals?.cacheRate ?? 0} tone={totals?.cacheRate === null ? "neutral" : "accent"} height={8} />
            </View>
          </StatTile>
          <StatTile
            {...tile("firstToken")}
            value={totals?.firstToken !== null && totals?.firstToken !== undefined ? secondsLabel(totals.firstToken).replace(" s", "") : "—"}
            unit="s"
            foot={totals?.context !== null && totals?.context !== undefined ? t("stats.avgContext", { value: tokens(Math.round(totals.context)) }) : " "}
          >
            <MiniColumns colors={colors} values={sparklines.firstToken} />
          </StatTile>
        </View>

        {stats && stats.totals.requests === 0 ? (
          <Card colors={colors} style={{ padding: space.xl, alignItems: "center" }}>
            <Muted colors={colors}>{t("stats.empty")}</Muted>
          </Card>
        ) : null}
        {stats && stats.totals.requests > 0 ? (
          <MetricChart colors={colors} stats={stats} metric={metric} locale={locale} compact={compact || width < 640} />
        ) : null}
        {stats && showAccountControls ? (
          <AccountTable
            colors={colors}
            rowsData={accountEntries}
            locale={locale}
            wide={width >= 820}
            selectedAccountId={accountId}
            onSelectAccount={handleSelectAccount}
          />
        ) : null}
        {stats && stats.models.length > 0 ? (
          <ModelTable
            colors={colors}
            stats={stats}
            locale={locale}
            wide={width >= 820}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onEditPricing={handleEditPricing}
          />
        ) : null}
      </View>

      {pricingOpen.open ? (
        <PricingDialog colors={colors} focusKey={pricingOpen.focusKey} onClose={() => setPricingOpen({ open: false })} />
      ) : null}
    </View>
  );
});
