// WCAG 2 contrast of the status badges (slice 5b review): each state's text over its tint, over the
// page, a card and a hovered table row (hover:bg-muted/50), in both themes. Colours come from the
// tokens of src/web/styles/main.css and the classes StatusBadge renders, composited in 8-bit sRGB
// as the browser paints them (OKLCH → sRGB per CSS Color 4). AA asks 4.5:1 for the badge's 12 px
// text.
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusBadge from "@/components/StatusBadge.vue";
import { createAppI18n } from "@/i18n";
import css from "@/styles/main.css?raw";
import type { CertificateStatusState, CrlStatusState } from "@/utils/status";

type Rgb = [number, number, number];

const STATES: (CertificateStatusState | CrlStatusState)[] = [
  "valid",
  "expiring",
  "expired",
  "not-yet-valid",
  "current",
  "stale",
  "unknown",
  "unpublished",
];

/** The `--name: oklch(L C H)` tokens of one rule block of main.css. */
function tokens(selector: string): Map<string, Rgb> {
  const block = new RegExp(`^${selector} \\{([^}]*)\\}`, "m").exec(css)?.[1];
  if (block === undefined) {
    throw new Error(`main.css has no ${selector} block`);
  }
  const found = new Map<string, Rgb>();
  for (const [, name, l, c, h] of block.matchAll(
    /--([\w-]+): oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g
  )) {
    found.set(name!, oklchToSrgb(Number(l), Number(c), Number(h)));
  }
  return found;
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): Rgb {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((value) => {
    const v = Math.min(1, Math.max(0, value));
    return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  }) as Rgb;
}

function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((value, index) => Math.round(value * alpha + bottom[index]! * (1 - alpha))) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The text and tint tokens of a badge's classes (`text-x`, `bg-x/10`, `dark:bg-x/20`). */
function badgeColours(classes: string[], known: Map<string, Rgb>, dark: boolean) {
  const text = classes
    .filter((name) => name.startsWith("text-"))
    .map((name) => name.slice("text-".length))
    .find((name) => known.has(name));
  const tint = classes
    .map((name) => /^(dark:)?bg-([\w-]+?)(?:\/(\d+))?$/.exec(name))
    .filter((match) => match !== null && known.has(match[2]!))
    .map((match) => ({ dark: match![1] !== undefined, token: match![2]!, alpha: match![3] }))
    // dark:bg-x replaces bg-x in the dark theme.
    .sort((a, b) => Number(b.dark) - Number(a.dark))
    .find((match) => dark || !match.dark);
  return {
    text: text ?? "foreground",
    tint: tint === undefined ? null : { token: tint.token, alpha: Number(tint.alpha ?? 100) / 100 },
  };
}

describe("status badge contrast", () => {
  const light = tokens(":root");
  const themes = { light, dark: new Map([...light, ...tokens("\\.dark")]) };

  it.each(Object.entries(themes))(
    "is at least 4.5:1 for every state in the %s theme",
    (theme, t) => {
      const token = (name: string) => {
        const value = t.get(name);
        if (value === undefined) {
          throw new Error(`no --${name} in the ${theme} theme`);
        }
        return value;
      };
      const surfaces = {
        page: token("background"),
        card: token("card"),
        "hovered row": over(token("muted"), 0.5, token("card")),
      };
      const ratios: string[] = [];
      for (const state of STATES) {
        const badge = mount(StatusBadge, {
          props: { state },
          global: { plugins: [createAppI18n("en")] },
        });
        const { text, tint } = badgeColours(badge.classes(), t, theme === "dark");
        badge.unmount();
        for (const [surface, background] of Object.entries(surfaces)) {
          const behind =
            tint === null ? background : over(token(tint.token), tint.alpha, background);
          const ratio = contrast(token(text), behind);
          ratios.push(`${state} on ${surface}: ${ratio.toFixed(2)}`);
          expect(ratio, `${theme}: ${state} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(ratios).toHaveLength(STATES.length * 3);
    }
  );
});
