import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usageDailyRpc, type StatsScope, type UsageDaily } from "../shared/contracts";
import { dayLabel, integer, longDate, monthShort, tokens, usdFixed, weekdayShort, weekStartsOn } from "./format";
import { messages } from "./messages";
import { font, radius, space, tabular, tint, type Colors } from "./theme";
import { Card } from "./ui";

const DAY_MS = 86_400_000;
const MAX_WEEKS = 53;
const LABEL_WIDTH = 30;
const LABEL_GAP = 6;
const MONTH_ROW = 20;
const MAX_PITCH = 17;
const MIN_PITCH = 12;
const TOOLTIP_WIDTH = 210;
/** Accent opacity per level: one hue, light to dark, so the scale reads the same in light and dark themes. */
const LEVEL_ALPHA = [0, 0.24, 0.46, 0.7, 1] as const;
const LEVELS = [0, 1, 2, 3, 4] as const;

type Level = (typeof LEVELS)[number];

interface DayCell {
  day: number;
  tokens: number;
  requests: number;
  cost: number | null;
  level: Level;
}

/** Days since 1970-01-01 for a "YYYY-MM-DD" key, counted on the calendar alone so time zones never shift it. */
function dayNumber(key: string): number {
  const [year = 1970, month = 1, date = 1] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

function todayNumber(): number {
  const now = new Date();
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** Local noon of a day number, for names and formatting. */
function localDate(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12);
}

function weekday(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

function dayOfMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCDate();
}

/**
 * Square cells as large as the width allows, up to a full year; narrow screens show fewer weeks.
 * The pitch may be fractional so the grid spans the card exactly; cells stay whole pixels and the
 * gaps absorb the fraction, which keeps every square the same size.
 */
function geometry(width: number) {
  const available = Math.max(0, width - LABEL_WIDTH - LABEL_GAP);
  let weeks: number = MAX_WEEKS;
  let pitch = Math.min(MAX_PITCH, available / MAX_WEEKS);
  if (pitch < MIN_PITCH) {
    weeks = Math.max(4, Math.floor(available / MIN_PITCH));
    pitch = available / weeks;
  }
  const cell = Math.max(6, Math.round(pitch * 0.8));
  const gridWidth = (weeks - 1) * pitch + cell;
  return { pitch, weeks, cell, gridWidth, labelWidth: LABEL_WIDTH, corner: cell >= 12 ? 3 : 2 };
}

/** Quartiles of the active days, like GitHub's contribution graph; the busiest day always takes the top level. */
function levelScale(values: readonly number[]): (value: number) => Level {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return () => 0;
  const pick = (quantile: number) => sorted[Math.floor(quantile * (sorted.length - 1))]!;
  const [low, middle, high] = [pick(0.25), pick(0.5), pick(0.75)];
  const max = sorted[sorted.length - 1]!;
  return (value) => {
    if (value <= 0) return 0;
    if (value >= max) return 4;
    if (value <= low) return 1;
    if (value <= middle) return 2;
    if (value <= high) return 3;
    return 4;
  };
}

function buildCalendar(data: UsageDaily | undefined, weeks: number, locale: string) {
  const today = data ? dayNumber(data.today) : todayNumber();
  const firstWeekday = weekStartsOn(locale);
  const todayRow = (weekday(today) - firstWeekday + 7) % 7;
  const firstDay = today - todayRow - (weeks - 1) * 7;
  const byDay = new Map((data?.days ?? []).map((entry) => [dayNumber(entry.date), entry]));
  const tokensOn = (day: number) => {
    const entry = byDay.get(day);
    return entry ? entry.input + entry.cached + entry.output : 0;
  };

  const visible: number[] = [];
  for (let day = firstDay; day <= today; day += 1) visible.push(tokensOn(day));
  const scale = levelScale(visible);

  const columns: Array<Array<DayCell | null>> = [];
  let total = 0;
  let activeDays = 0;
  let busiest: DayCell | null = null;
  for (let column = 0; column < weeks; column += 1) {
    const cells: Array<DayCell | null> = [];
    for (let row = 0; row < 7; row += 1) {
      const day = firstDay + column * 7 + row;
      if (day > today) {
        cells.push(null);
        continue;
      }
      const entry = byDay.get(day);
      const value = tokensOn(day);
      const cell: DayCell = {
        day,
        tokens: value,
        requests: entry?.requests ?? 0,
        cost: entry && entry.pricedRequests > 0 ? entry.cost : null,
        level: scale(value),
      };
      cells.push(cell);
      total += value;
      if (value > 0) activeDays += 1;
      if (value > 0 && (!busiest || value > busiest.tokens)) busiest = cell;
    }
    columns.push(cells);
  }

  // A streak still counts while today has no calls yet; it ends at the first idle day before that,
  // even past the weeks a narrow screen shows.
  let streak = 0;
  for (let day = tokensOn(today) > 0 ? today : today - 1; tokensOn(day) > 0; day -= 1) streak += 1;

  // A month's name sits over the week holding its 1st, unless it would crowd the previous name.
  const months: Array<{ column: number; label: string }> = [];
  for (let column = 0; column < weeks; column += 1) {
    for (let row = 0; row < 7; row += 1) {
      const day = firstDay + column * 7 + row;
      if (day > today) break;
      if (dayOfMonth(day) !== 1) continue;
      const previous = months[months.length - 1];
      if (!previous || column - previous.column >= 3) months.push({ column, label: monthShort(localDate(day), locale) });
      break;
    }
  }
  if ((months[0]?.column ?? weeks) >= 3) months.unshift({ column: 0, label: monthShort(localDate(firstDay + 6), locale) });

  const weekdays = Array.from({ length: 7 }, (_, row) => {
    const day = firstDay + row;
    // Label Monday, Wednesday and Friday, as GitHub does.
    return [1, 3, 5].includes(weekday(day)) ? weekdayShort(localDate(day), locale) : "";
  });

  return {
    columns,
    months,
    weekdays,
    total,
    activeDays,
    busiest,
    streak,
    average: activeDays > 0 ? total / activeDays : 0,
  };
}

const CalendarCell = memo(function CalendarCell({
  index,
  pitch,
  size,
  corner,
  color,
  label,
  onEnter,
  onTap,
}: {
  index: number;
  pitch: number;
  size: number;
  corner: number;
  color: string;
  label: string;
  onEnter(index: number): void;
  onTap(index: number): void;
}) {
  // The hit target is the whole slot, gap included, so the pointer never falls between days.
  return (
    <Pressable
      accessibilityLabel={label}
      focusable={false}
      onHoverIn={() => onEnter(index)}
      onPress={(event) => {
        // The grid around the days dismisses on press; a tap on a day must not reach it.
        event.stopPropagation?.();
        onTap(index);
      }}
      style={{ width: pitch, height: pitch }}
    >
      <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: color }} />
    </Pressable>
  );
});

function Figure({ colors, label, value, detail }: { colors: Colors; label: string; value: string; detail?: string }) {
  return (
    <View style={{ gap: 2, minWidth: 88 }}>
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ ...font.small, color: colors.foreground, fontWeight: "600" }}>
        {value}
        {detail ? <Text style={{ fontWeight: "400", color: colors.foregroundMuted }}>{`  ${detail}`}</Text> : null}
      </Text>
    </View>
  );
}

export const ActivityCalendar = memo(function ActivityCalendar({
  colors,
  width,
  compact,
  scope,
  accountId,
  model,
}: {
  colors: Colors;
  width: number;
  compact: boolean;
  scope: StatsScope;
  accountId: string | null;
  model: string | null;
}) {
  const { t, locale } = useTranslation(messages);
  const read = useRpc(usageDailyRpc);
  const query = useQuery({
    // Under the "stats" prefix, so a pricing change refreshes the calendar's costs with the rest.
    queryKey: ["antigravity-accounts", "stats", "daily", scope, accountId ?? "", model ?? ""],
    queryFn: () =>
      read({
        scope,
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
      }),
    refetchInterval: 60_000,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const padding = compact ? space.md : space.lg;
  const inner = Math.max(0, width - padding * 2 - 2);
  const { pitch, weeks, cell, gridWidth, labelWidth, corner } = geometry(inner);
  const calendar = useMemo(() => buildCalendar(query.data, weeks, locale), [query.data, weeks, locale]);
  // Built once per data change, not on every hover.
  const labels = useMemo(
    () =>
      calendar.columns.map((cells) =>
        cells.map((day) =>
          day
            ? `${longDate(localDate(day.day), locale)}: ${
                day.tokens > 0 ? t("stats.readoutTokens", { value: tokens(day.tokens) }) : t("stats.calendar.none")
              }`
            : "",
        ),
      ),
    [calendar, locale, t],
  );
  const [active, setActive] = useState<number | null>(null);
  const pointer = useRef(false);
  const enter = useCallback((index: number) => {
    pointer.current = true;
    setActive(index);
  }, []);
  // With a mouse the hover already shows the day. Without one, a tap toggles it, so it can be closed.
  const tap = useCallback(
    (index: number) => setActive((current) => (pointer.current ? index : current === index ? null : index)),
    [],
  );
  const leave = useCallback(() => {
    pointer.current = false;
    setActive(null);
  }, []);
  // A cell index means a different day once the number of weeks changes.
  useEffect(() => setActive(null), [weeks]);
  const levelColors = useMemo(
    () =>
      [
        tint(colors.foreground, 0.07),
        tint(colors.accent, LEVEL_ALPHA[1]),
        tint(colors.accent, LEVEL_ALPHA[2]),
        tint(colors.accent, LEVEL_ALPHA[3]),
        tint(colors.accent, LEVEL_ALPHA[4]),
      ] as const,
    [colors.foreground, colors.accent],
  );
  const monthLabels = useMemo(() => {
    const placed: Array<{ key: string; left: number; label: string }> = [];
    const maxLeft = Math.max(0, gridWidth - 28);
    for (const month of calendar.months) {
      const left = Math.min(month.column * pitch, maxLeft);
      const prev = placed[placed.length - 1];
      if (prev && left - prev.left < 30) {
        // Keep the newer month label when the first column's fallback label would crowd it, else drop the clamped edge label.
        if (prev.left === 0 && month.column < calendar.columns.length - 2) {
          placed[placed.length - 1] = { key: `${month.column}-${month.label}`, left, label: month.label };
        }
        continue;
      }
      placed.push({ key: `${month.column}-${month.label}`, left, label: month.label });
    }
    return placed;
  }, [calendar.months, calendar.columns.length, gridWidth, pitch]);

  const gridHeight = MONTH_ROW + 7 * pitch;

  const activeColumn = active === null ? -1 : Math.floor(active / 7);
  const activeRow = active === null ? -1 : active % 7;
  const activeCell = active === null ? null : (calendar.columns[activeColumn]?.[activeRow] ?? null);
  // The tooltip centers on the day but never leaves the card: it stays between the weekday labels on the
  // left and the grid's edge on the right, and drops below the day in the top rows. It is positioned in
  // the row that holds the labels and the grid, so every offset is non-negative.
  const gridLeft = labelWidth + LABEL_GAP;
  const blockWidth = gridLeft + gridWidth;
  const tooltipWidth = Math.min(TOOLTIP_WIDTH, blockWidth);
  const tooltipLeft = Math.min(
    Math.max(gridLeft + activeColumn * pitch + cell / 2 - tooltipWidth / 2, 0),
    blockWidth - tooltipWidth,
  );
  const tooltipBelow = activeRow <= 2;
  const heading = query.data
    ? weeks >= 52
      ? t("stats.calendar.totalYear", { value: tokens(calendar.total) })
      : t("stats.calendar.totalWeeks", { value: tokens(calendar.total), count: weeks })
    : t("stats.calendar.title");

  const legend = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }} accessibilityLabel={t("stats.calendar.legend")}>
      <Text style={{ ...font.caption, color: colors.foregroundMuted, marginRight: 3 }}>{t("stats.calendar.less")}</Text>
      {LEVELS.map((level) => (
        <View key={level} style={{ width: cell, height: cell, borderRadius: corner, backgroundColor: levelColors[level] }} />
      ))}
      <Text style={{ ...font.caption, color: colors.foregroundMuted, marginLeft: 3 }}>{t("stats.calendar.more")}</Text>
    </View>
  );

  return (
    <Card colors={colors} style={{ padding, gap: space.md, opacity: query.isPlaceholderData ? 0.6 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
          {heading}
        </Text>
      </View>
      {query.error ? (
        <Text style={{ ...font.small, color: colors.statusDanger }}>{(query.error as Error).message}</Text>
      ) : null}

      {/* Stacked above the figures that follow, so a tooltip running past the grid stays on top on native too. */}
      <View style={{ flexDirection: "row", zIndex: 1 }}>
        <View style={{ width: labelWidth, marginRight: LABEL_GAP, height: gridHeight }}>
          {calendar.weekdays.map((label, row) =>
            label ? (
              <Text
                key={row}
                numberOfLines={1}
                style={{
                  position: "absolute",
                  right: 0,
                  top: MONTH_ROW + row * pitch + (cell - 14) / 2,
                  fontSize: 11,
                  lineHeight: 14,
                  color: colors.foregroundMuted,
                }}
              >
                {label}
              </Text>
            ) : null,
          )}
        </View>
        <View style={{ width: gridWidth, height: gridHeight }}>
          {monthLabels.map((month) => (
            <Text
              key={month.key}
              numberOfLines={1}
              style={{
                position: "absolute",
                left: month.left,
                top: 0,
                fontSize: 11,
                lineHeight: 14,
                color: colors.foregroundMuted,
              }}
            >
              {month.label}
            </Text>
          ))}
          <Pressable
            accessible={false}
            focusable={false}
            onHoverOut={leave}
            onPress={() => setActive(null)}
            style={{ position: "absolute", left: 0, top: MONTH_ROW, flexDirection: "row" }}
          >
            {calendar.columns.map((cells, column) => (
              <View key={column} style={{ width: pitch }}>
                {cells.map((day, row) =>
                  day ? (
                    <CalendarCell
                      key={row}
                      index={column * 7 + row}
                      pitch={pitch}
                      size={cell}
                      corner={corner}
                      color={levelColors[day.level]}
                      label={labels[column]?.[row] ?? ""}
                      onEnter={enter}
                      onTap={tap}
                    />
                  ) : (
                    <View key={row} style={{ width: pitch, height: pitch }} />
                  ),
                )}
              </View>
            ))}
          </Pressable>

          {activeCell ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: activeColumn * pitch - 2,
                top: MONTH_ROW + activeRow * pitch - 2,
                width: cell + 4,
                height: cell + 4,
                borderRadius: corner + 2,
                borderWidth: 1.5,
                borderColor: colors.foreground,
              }}
            />
          ) : null}
        </View>

        {activeCell ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              zIndex: 10,
              left: tooltipLeft,
              width: tooltipWidth,
              ...(tooltipBelow
                ? { top: MONTH_ROW + activeRow * pitch + cell + 6 }
                : { bottom: gridHeight - (MONTH_ROW + activeRow * pitch) + 6 }),
              paddingHorizontal: space.sm + 2,
              paddingVertical: space.xs + 2,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface0,
              shadowColor: colors.foreground,
              shadowOpacity: 0.12,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 4 },
              elevation: 4,
              gap: 1,
            }}
          >
            <Text numberOfLines={1} style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}>
              {activeCell.tokens > 0
                ? t("stats.readoutTokens", { value: tokens(activeCell.tokens) })
                : t("stats.calendar.none")}
            </Text>
            <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
              {longDate(localDate(activeCell.day), locale)}
            </Text>
            {activeCell.requests > 0 ? (
              <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                {[
                  t("stats.readoutRequests", { count: activeCell.requests, value: integer(activeCell.requests, locale) }),
                  activeCell.cost !== null ? usdFixed(activeCell.cost, locale) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          columnGap: space.xl,
          rowGap: space.md,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: compact ? space.lg : space.xxl, rowGap: space.sm, flexShrink: 1 }}>
          <Figure colors={colors} label={t("stats.calendar.activeDays")} value={integer(calendar.activeDays, locale)} />
          <Figure
            colors={colors}
            label={t("stats.calendar.busiest")}
            value={calendar.busiest ? tokens(calendar.busiest.tokens) : "—"}
            detail={calendar.busiest ? dayLabel(localDate(calendar.busiest.day), locale) : undefined}
          />
          <Figure colors={colors} label={t("stats.calendar.average")} value={calendar.activeDays > 0 ? tokens(Math.round(calendar.average)) : "—"} />
          <Figure colors={colors} label={t("stats.calendar.streak")} value={t("stats.calendar.days", { count: calendar.streak })} />
        </View>
        {legend}
      </View>
    </Card>
  );
});
