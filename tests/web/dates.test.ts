// Date display helpers. The time zone is set per test through TZ (Node applies a changed TZ to
// Date and Intl at once); the clock is always passed in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";
import type { DateText } from "@/utils/dates";
import {
  formatDateDay,
  formatDateDayWithoutTimezone,
  formatDateTimeWithZone,
  formatRelativeDetailedSeconds,
  formatRelativeSeconds,
  getRelativeTime,
  getRelativeTimeDetailed,
} from "@/utils/dates";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** What useDateText returns, from the app's own messages. */
function dateText(locale: AppLocale): DateText {
  const { t } = createAppI18n(locale).global;
  return { locale, t: (key, named) => (named === undefined ? t(key) : t(key, named)) };
}

const en = dateText("en");
const zh = dateText("zh-CN");

const ISO = "2026-01-04T00:05:07Z";
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("absolute dates", () => {
  it("labels each date with its own offset, daylight saving time included", () => {
    // Newfoundland: UTC-3:30 in January, UTC-2:30 in July.
    vi.stubEnv("TZ", "America/St_Johns");
    expect(formatDateTimeWithZone("2026-07-04T00:05:07Z", en)).toBe(
      "Jul 03, 2026 21:35:07 (UTC-2:30)"
    );
    expect(formatDateTimeWithZone(ISO, en)).toBe("Jan 03, 2026 20:35:07 (UTC-3:30)");
  });

  it("prints five past midnight as 00:05, not 24:05 (hourCycle h23)", () => {
    vi.stubEnv("TZ", "UTC");
    // Node prints 00:05 for hour12: false too (some browsers print 24:05): look at what is asked.
    const DateTimeFormat = Intl.DateTimeFormat;
    const asked: Intl.DateTimeFormatOptions[] = [];
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      asked.push(options ?? {});
      return new DateTimeFormat(locales, options);
    });

    expect(formatDateTimeWithZone(ISO, en)).toBe("Jan 04, 2026 00:05:07 (UTC)");
    const time = asked.filter((options) => options.hour !== undefined);
    expect(time.length).toBeGreaterThan(0);
    for (const options of time) {
      expect(options).toMatchObject({ hourCycle: "h23" });
      expect(options).not.toHaveProperty("hour12");
    }
  });

  it("shows the local time with its offset", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(formatDateTimeWithZone(ISO, en)).toBe("Jan 04, 2026 05:35:07 (UTC+5:30)");
    vi.stubEnv("TZ", "America/St_Johns");
    expect(formatDateDay(ISO, en)).toBe("Jan 03, 2026 (UTC-3:30)");
    expect(formatDateDayWithoutTimezone(ISO, en)).toBe("Jan 03, 2026");
  });

  it("formats in the message locale (zh-CN)", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    expect(formatDateTimeWithZone(ISO, zh)).toBe("2026年1月04日 08:05:07 (UTC+8)");
    expect(formatDateDay(ISO, zh)).toBe("2026年1月04日 (UTC+8)");
  });

  it("says N/A without a date and keeps text that is no date", () => {
    expect(formatDateTimeWithZone(null, en)).toBe("N/A");
    expect(formatDateDay(undefined, zh)).toBe("无");
    expect(formatDateDayWithoutTimezone("", en)).toBe("N/A");
    expect(formatDateTimeWithZone("not a date", en)).toBe("not a date");
  });
});

describe("relative times", () => {
  it("rounds to minutes, shows at least one and carries 60 minutes into the hour", () => {
    expect(formatRelativeSeconds(0, en)).toBe("now");
    expect(formatRelativeSeconds(29, en)).toBe("in 1m");
    expect(formatRelativeSeconds(-29, en)).toBe("1m ago");
    expect(formatRelativeSeconds(59 * MINUTE + 29, en)).toBe("in 59m");
    expect(formatRelativeSeconds(59 * MINUTE + 30, en)).toBe("in 1h");
    expect(formatRelativeSeconds(-(2 * HOUR + 5 * MINUTE), en)).toBe("2h 5m ago");
    expect(formatRelativeSeconds(DAY - 1, en)).toBe("in 24h");
  });

  it("switches to whole days from one day on", () => {
    expect(formatRelativeSeconds(DAY, en)).toBe("in 1 day");
    expect(formatRelativeSeconds(3 * DAY + 13 * HOUR, en)).toBe("in 4 days");
    expect(formatRelativeSeconds(-3 * DAY, en)).toBe("3 days ago");
  });

  it("details days, hours and minutes", () => {
    expect(formatRelativeDetailedSeconds(3 * DAY + 4 * HOUR + 5 * MINUTE, en)).toBe("in 3d 4h 5m");
    expect(formatRelativeDetailedSeconds(-2 * DAY, en)).toBe("2d ago");
    expect(formatRelativeDetailedSeconds(10, en)).toBe("in 1m");
  });

  it("measures from the injected clock, not Date.now()", () => {
    const at = Date.parse(ISO);
    expect(getRelativeTime(ISO, at - 2 * HOUR * 1000, en)).toBe("in 2h");
    expect(getRelativeTime(ISO, at + 5 * MINUTE * 1000, en)).toBe("5m ago");
    expect(getRelativeTime(ISO, at, en)).toBe("now");
    expect(getRelativeTimeDetailed(ISO, at - (DAY + HOUR) * 1000, en)).toBe("in 1d 1h");
    expect(getRelativeTime(null, at, en)).toBe("");
    expect(getRelativeTimeDetailed("not a date", at, en)).toBe("");
  });

  it("speaks zh-CN", () => {
    const at = Date.parse(ISO);
    expect(getRelativeTime(ISO, at + (2 * HOUR + 5 * MINUTE) * 1000, zh)).toBe("2小时 5分钟前");
    expect(getRelativeTimeDetailed(ISO, at - (DAY + 30 * MINUTE) * 1000, zh)).toBe("1天 30分钟后");
  });
});
