// Dates and relative times for display. From worker-aia-cdp@5b570aa:src/web/utils/dates.ts, with
// the module-level i18n instance replaced by a DateText argument (useDateText in components), the
// clock passed in to the relative times (nowMs, from useClock), hourCycle "h23" instead of
// hour12: false (which some engines render as 24:05 for five past midnight), and without the
// duplicate formatDateReadable. Times show in the browser's time zone, labelled with its offset.

/** What the formatters need from vue-i18n. */
export interface DateText {
  /** The message locale, also used for Intl. */
  readonly locale: string;
  readonly t: (key: string, named?: Record<string, unknown>) => string;
}

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

function formatDatePart(date: Date, text: DateText): string {
  return new Intl.DateTimeFormat(text.locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatTimePart(date: Date, text: DateText): string {
  return new Intl.DateTimeFormat(text.locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function withDirection(value: string, sign: number, text: DateText): string {
  return sign >= 0 ? text.t("dates.in", { value }) : text.t("dates.ago", { value });
}

/**
 * `iso` as a date, through `format`; N/A without a value, the text itself when it is no date
 * (Intl throws a RangeError for an invalid Date).
 */
function formatIso(
  iso: string | null | undefined,
  text: DateText,
  format: (date: Date) => string
): string {
  if (iso === null || iso === undefined || iso === "") {
    return text.t("common.notAvailable");
  }
  try {
    return format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The local UTC offset at `date`: "UTC", "UTC+8", "UTC-3:30". */
export function formatTimezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return "UTC";
  }
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60));
  const minutes = absMinutes % 60;
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** "Jan 04, 2026 00:05:07 (UTC)". */
export function formatDateTimeWithZone(iso: string | null | undefined, text: DateText): string {
  return formatIso(
    iso,
    text,
    (date) =>
      `${formatDatePart(date, text)} ${formatTimePart(date, text)} (${formatTimezoneOffset(date)})`
  );
}

/** "Jan 04, 2026 (UTC)". */
export function formatDateDay(iso: string | null | undefined, text: DateText): string {
  return formatIso(
    iso,
    text,
    (date) => `${formatDatePart(date, text)} (${formatTimezoneOffset(date)})`
  );
}

/** "Jan 04, 2026". */
export function formatDateDayWithoutTimezone(
  iso: string | null | undefined,
  text: DateText
): string {
  return formatIso(iso, text, (date) => formatDatePart(date, text));
}

/**
 * A signed distance in seconds (positive: in the future) as "in 2h 5m" / "5m ago" below a day,
 * else in the largest whole unit through Intl.RelativeTimeFormat ("in 3 days"). Minutes are
 * rounded, never shown as 0, and 60 of them carry into the hour.
 */
export function formatRelativeSeconds(seconds: number, text: DateText): string {
  if (!Number.isFinite(seconds)) {
    return "";
  }
  const abs = Math.abs(seconds);
  const sign = seconds >= 0 ? 1 : -1;

  if (abs < DAY_S) {
    if (abs === 0) {
      return text.t("dates.now");
    }
    const totalMinutes = Math.max(1, Math.round(abs / MINUTE_S));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const segments: string[] = [];
    if (hours > 0) {
      segments.push(`${String(hours)}${text.t("dates.short.hour")}`);
    }
    if (minutes > 0 || segments.length === 0) {
      segments.push(`${String(minutes)}${text.t("dates.short.minute")}`);
    }
    return withDirection(segments.join(" "), sign, text);
  }

  const formatter = new Intl.RelativeTimeFormat(text.locale, { numeric: "always" });
  return formatter.format(sign * Math.round(abs / DAY_S), "day");
}

/** "in 3d 4h 5m" / "5m ago": every unit down to rounded minutes (at least 1 minute). */
export function formatRelativeDetailedSeconds(seconds: number, text: DateText): string {
  if (!Number.isFinite(seconds)) {
    return "";
  }
  const sign = seconds >= 0 ? 1 : -1;
  const totalMinutes = Math.max(1, Math.round(Math.abs(seconds) / MINUTE_S));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const segments: string[] = [];
  if (days > 0) {
    segments.push(`${String(days)}${text.t("dates.short.day")}`);
  }
  if (hours > 0) {
    segments.push(`${String(hours)}${text.t("dates.short.hour")}`);
  }
  if (minutes > 0 || segments.length === 0) {
    segments.push(`${String(minutes)}${text.t("dates.short.minute")}`);
  }
  return withDirection(segments.join(" "), sign, text);
}

/** Whole seconds from `nowMs` to `iso` (negative in the past); null without a valid date. */
function secondsUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (iso === null || iso === undefined || iso === "") {
    return null;
  }
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : Math.floor((time - nowMs) / 1000);
}

/** formatRelativeSeconds from `nowMs` to `iso`; "" without a valid date. */
export function getRelativeTime(
  iso: string | null | undefined,
  nowMs: number,
  text: DateText
): string {
  const seconds = secondsUntil(iso, nowMs);
  return seconds === null ? "" : formatRelativeSeconds(seconds, text);
}

/** formatRelativeDetailedSeconds from `nowMs` to `iso`; "" without a valid date. */
export function getRelativeTimeDetailed(
  iso: string | null | undefined,
  nowMs: number,
  text: DateText
): string {
  const seconds = secondsUntil(iso, nowMs);
  return seconds === null ? "" : formatRelativeDetailedSeconds(seconds, text);
}
