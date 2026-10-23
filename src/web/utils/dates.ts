// Dates and relative times for display. vue-i18n comes in as a DateText argument (useDateText in
// components) and the clock as nowMs (from useClock) for the relative times. Hours use hourCycle
// "h23": hour12: false renders five past midnight as 24:05 in some engines. Times show in the
// browser's time zone, labelled with its offset.

/** What the formatters need from vue-i18n. */
export interface DateText {
  /** The message locale, also used for Intl. */
  readonly locale: string;
  readonly t: (key: string, named?: Record<string, unknown>) => string;
}

const DAY_S = 24 * 60 * 60;
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  year: "numeric",
};
const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

/** The local UTC offset at `date`: "UTC", "UTC+8", "UTC-3:30". */
function formatTimezoneOffset(date: Date): string {
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

/**
 * "Jan 04, 2026 00:05:07 (UTC)", without the time or the offset when they are turned off; N/A
 * without a value, the text itself when it is no date.
 */
export function formatDate(
  iso: string | null | undefined,
  text: DateText,
  { time = true, zone = true } = {}
): string {
  if (!iso) {
    return text.t("common.notAvailable");
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return [
    new Intl.DateTimeFormat(text.locale, DATE_OPTIONS).format(date),
    time ? new Intl.DateTimeFormat(text.locale, TIME_OPTIONS).format(date) : "",
    zone ? `(${formatTimezoneOffset(date)})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The distance from `nowMs` to `iso` as "in 2h 5m" / "5m ago": minutes are rounded, never shown as
 * 0, and 60 of them carry into the hour. From one day on it is whole days through
 * Intl.RelativeTimeFormat ("in 3 days"), unless `detailed` asks for every unit ("in 3d 4h 5m").
 * "" without a valid date.
 */
export function relativeTime(
  iso: string | null | undefined,
  nowMs: number,
  text: DateText,
  detailed = false
): string {
  const seconds = Math.floor((Date.parse(iso ?? "") - nowMs) / 1000);
  if (Number.isNaN(seconds)) {
    return "";
  }
  const abs = Math.abs(seconds);
  if (!detailed && abs >= DAY_S) {
    const days = Math.sign(seconds) * Math.round(abs / DAY_S);
    return new Intl.RelativeTimeFormat(text.locale).format(days, "day");
  }
  if (!detailed && seconds === 0) {
    return text.t("dates.now");
  }
  const total = Math.max(1, Math.round(abs / 60));
  const days = detailed ? Math.floor(total / (24 * 60)) : 0;
  const units = [
    [days, "day"],
    [Math.floor((total - days * 24 * 60) / 60), "hour"],
    [total % 60, "minute"],
  ] as const;
  const value = units
    .filter(([count]) => count > 0)
    .map(([count, unit]) => `${String(count)}${text.t(`dates.short.${unit}`)}`)
    .join(" ");
  return text.t(seconds >= 0 ? "dates.in" : "dates.ago", { value });
}
