export function safeLocale(locale: string | undefined): string {
  const cleaned = (locale ?? "").trim().replace(/_/g, "-");
  return cleaned || "en";
}

function isChineseLocale(locale: string | undefined): boolean {
  return safeLocale(locale).toLowerCase().startsWith("zh");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function groupThousands(intText: string): string {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Locale-aware uppercase that never throws on partial ICU / Hermes locale tags. */
export function upper(text: string, locale?: string): string {
  try {
    return locale ? text.toLocaleUpperCase(safeLocale(locale)) : text.toLocaleUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

/** "11.8K", "456K", "1M", "1.05M" — compact token counts. */
export function tokens(value: number): string {
  if (value >= 1_000_000) {
    // Context windows are binary sizes: 1,048,576 reads as "1M".
    const millions = value % 1_048_576 === 0 ? value / 1_048_576 : value / 1_000_000;
    return `${trim(millions, millions >= 10 ? 0 : 2)}M`;
  }
  if (value >= 1000) return `${trim(value / 1000, value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

/** Fixed digits without trailing fraction zeros: 1.50 → "1.5", 300 → "300". */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

const numberFormatters = new Map<string, Intl.NumberFormat | null>();

function getNumberFormatter(
  key: string,
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat | null {
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = null;
    if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
      try {
        formatter = options ? new Intl.NumberFormat(locale, options) : new Intl.NumberFormat(locale);
      } catch {
        // Fall back when unsupported on this ICU / Hermes build.
      }
    }
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export function percent(fraction: number, locale: string): string {
  const digits = fraction > 0 && fraction < 0.01 ? 1 : 0;
  const loc = safeLocale(locale);
  const formatter = getNumberFormatter(`${loc}|pct|${digits}`, loc, {
    style: "percent",
    maximumFractionDigits: digits,
  });
  if (formatter) {
    try {
      return formatter.format(fraction);
    } catch {
      // Fall through to plain percentage formatting.
    }
  }
  return `${trim(fraction * 100, digits)}%`;
}

export function integer(value: number, locale: string): string {
  const loc = safeLocale(locale);
  const formatter = getNumberFormatter(`${loc}|int`, loc);
  if (formatter) {
    try {
      return formatter.format(value);
    } catch {
      // Fall through to ASCII grouping.
    }
  }
  return groupThousands(String(Math.round(value)));
}

/** "$0.00", "$0.0042", "$1.28", "$124.50", "$1,234" — readable USD cost formatting. */
export function usd(value: number, locale = "en-US"): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.0001) return "<$0.0001";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value >= 1000) {
    return `$${integer(Math.round(value), locale)}`;
  }
  const loc = safeLocale(locale);
  const formatter = getNumberFormatter(`${loc}|usd2`, loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (formatter) {
    try {
      return `$${formatter.format(value)}`;
    } catch {
      // Fall through to fixed two-decimal formatting.
    }
  }
  return `$${value.toFixed(2)}`;
}

/** "$113.05", "$0.12", "<$0.01": always two decimals, so a column of costs lines up on the point. */
export function usdFixed(value: number, locale = "en-US"): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.005) return "<$0.01";
  const loc = safeLocale(locale);
  const formatter = getNumberFormatter(`${loc}|usd2`, loc, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (formatter) {
    try {
      return `$${formatter.format(value)}`;
    } catch {
      // Fall through to ASCII grouping.
    }
  }
  const [whole = "0", fraction = "00"] = value.toFixed(2).split(".");
  return `$${groupThousands(whole)}.${fraction}`;
}

/** Compact USD formatter for chart Y-axis ticks. */
export function usdShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${trim(value, 4)}`;
  if (value < 1) return `$${trim(value, 3)}`;
  if (value < 100) return `$${trim(value, 2)}`;
  return `$${Math.round(value)}`;
}

type RelativeUnit = "second" | "minute" | "hour" | "day";

function fallbackRelative(value: number, unit: RelativeUnit, locale: string): string {
  const zh = isChineseLocale(locale);
  if (unit === "second" || value === 0) {
    return zh ? "现在" : "now";
  }
  const abs = Math.abs(value);
  const future = value > 0;
  if (unit === "day" && abs === 1) {
    return zh ? (future ? "明天" : "昨天") : future ? "tomorrow" : "yesterday";
  }
  if (zh) {
    const unitName = unit === "minute" ? "分钟" : unit === "hour" ? "小时" : "天";
    return `${abs} ${unitName}${future ? "后" : "前"}`;
  }
  const unitName = abs === 1 ? unit : `${unit}s`;
  return future ? `in ${abs} ${unitName}` : `${abs} ${unitName} ago`;
}

type RelativeFormatter = { format(val: number, u: RelativeUnit): string };
const relativeFormatters = new Map<string, RelativeFormatter | null>();

function getRelativeFormatter(locale: string): RelativeFormatter | null {
  let formatter = relativeFormatters.get(locale);
  if (formatter === undefined) {
    formatter = null;
    const RelativeTimeFormat =
      typeof Intl !== "undefined"
        ? (
            Intl as {
              RelativeTimeFormat?: new (
                locales?: string,
                options?: { numeric?: "always" | "auto" },
              ) => RelativeFormatter;
            }
          ).RelativeTimeFormat
        : undefined;
    if (typeof RelativeTimeFormat === "function") {
      try {
        formatter = new RelativeTimeFormat(locale, { numeric: "auto" });
      } catch {
        // Fall through to built-in relative formatter.
      }
    }
    relativeFormatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * "in 3 hours" / "5 minutes ago" in the app language.
 * Falls back cleanly on React Native Hermes where `Intl.RelativeTimeFormat` is undefined.
 */
export function relative(timestamp: string | number, now: number, locale: string): string {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const absolute = Math.abs(seconds);
  const [value, unit]: [number, RelativeUnit] =
    absolute < 45
      ? [0, "second"]
      : absolute < 3600
        ? [Math.round(seconds / 60), "minute"]
        : absolute < 86_400
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86_400), "day"];

  const formatter = getRelativeFormatter(safeLocale(locale));
  if (formatter) {
    try {
      return formatter.format(value, unit);
    } catch {
      // Fall through to built-in relative formatter.
    }
  }
  return fallbackRelative(value, unit, locale);
}

/** Elapsed duration ("12s", "9m", "1h 15m"), safe on Hermes builds without `style: "unit"`. */
export function duration(start: string | null, end: string | null, locale: string): string | null {
  const from = start ? Date.parse(start) : NaN;
  const to = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  const loc = safeLocale(locale);
  const zh = isChineseLocale(locale);
  const formatUnit = (value: number, unit: "second" | "minute" | "hour") => {
    const formatter = getNumberFormatter(`${loc}|unit|${unit}`, loc, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
    });
    if (formatter) {
      try {
        return formatter.format(value);
      } catch {
        // Fall through on Hermes builds that reject `style: "unit"`.
      }
    }
    if (zh) {
      const suffix = unit === "second" ? "秒" : unit === "minute" ? "分" : "小时";
      return `${value}${suffix}`;
    }
    const suffix = unit === "second" ? "s" : unit === "minute" ? "m" : "h";
    return `${value}${suffix}`;
  };
  if (seconds < 60) return formatUnit(Math.max(1, seconds), "second");
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return formatUnit(totalMinutes, "minute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${formatUnit(hours, "hour")} ${formatUnit(minutes, "minute")}` : formatUnit(hours, "hour");
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ZH_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type DatePreset = "monthShort" | "weekdayShort" | "dayLabel" | "longDate" | "clockHM" | "clockHMS" | "monthDay";

const DATE_PRESET_OPTIONS: Record<DatePreset, Intl.DateTimeFormatOptions> = {
  monthShort: { month: "short" },
  weekdayShort: { weekday: "short" },
  dayLabel: { month: "short", day: "numeric" },
  longDate: { weekday: "short", year: "numeric", month: "short", day: "numeric" },
  clockHM: { hour: "2-digit", minute: "2-digit", hour12: false },
  clockHMS: { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  monthDay: { month: "numeric", day: "numeric" },
};

/** Formatters are costly to build and charts format hundreds of dates, so each one is made once. */
const dateFormatters = new Map<string, Intl.DateTimeFormat | null>();

function dateText(date: Date, locale: string, preset: DatePreset, fallback: () => string): string {
  if (!Number.isFinite(date.getTime())) return "";
  const loc = safeLocale(locale);
  const key = `${loc}|${preset}`;
  let formatter = dateFormatters.get(key);
  if (formatter === undefined) {
    formatter = null;
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      try {
        formatter = new Intl.DateTimeFormat(loc, DATE_PRESET_OPTIONS[preset]);
      } catch {
        // Fall back to the built-in names.
      }
    }
    dateFormatters.set(key, formatter);
  }
  if (formatter) {
    try {
      return formatter.format(date);
    } catch {
      // Fall through to the built-in names.
    }
  }
  return fallback();
}

/** 24-hour clock string ("14:05" or "14:05:09"), safe across mobile ICU implementations. */
export function clockTime(timestamp: string | number | Date, locale: string, withSeconds = false): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return dateText(date, locale, withSeconds ? "clockHMS" : "clockHM", () => {
    const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
  });
}

/** Short month name ("Nov", "11月"). */
export function monthShort(date: Date, locale: string): string {
  return dateText(date, locale, "monthShort", () =>
    isChineseLocale(locale) ? `${date.getMonth() + 1}月` : EN_MONTHS[date.getMonth()]!,
  );
}

/** Short weekday name ("Mon", "周一"). */
export function weekdayShort(date: Date, locale: string): string {
  return dateText(date, locale, "weekdayShort", () =>
    (isChineseLocale(locale) ? ZH_WEEKDAYS : EN_WEEKDAYS)[date.getDay()]!,
  );
}

/** Month and day in words ("Nov 23", "11月23日"). */
export function dayLabel(date: Date, locale: string): string {
  return dateText(date, locale, "dayLabel", () =>
    isChineseLocale(locale) ? `${date.getMonth() + 1}月${date.getDate()}日` : `${EN_MONTHS[date.getMonth()]} ${date.getDate()}`,
  );
}

/** Full date with weekday ("Sun, Nov 23, 2026", "2026年11月23日周日"). */
export function longDate(date: Date, locale: string): string {
  return dateText(date, locale, "longDate", () =>
    isChineseLocale(locale)
      ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${ZH_WEEKDAYS[date.getDay()]}`
      : `${EN_WEEKDAYS[date.getDay()]}, ${EN_MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`,
  );
}

/** Sunday-first weeks in English, Monday-first in Chinese. */
export function weekStartsOn(locale: string): 0 | 1 {
  return isChineseLocale(locale) ? 1 : 0;
}

/** Month/day label ("11/23"), safe across mobile ICU implementations. */
export function monthDay(timestamp: number | Date, locale: string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return dateText(date, locale, "monthDay", () => `${date.getMonth() + 1}/${date.getDate()}`);
}
