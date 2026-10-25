// The values of the UI's label / value lists (KeyValueList) and extension bodies, each drawn by
// ValueView in exactly one way: text, grouped hex with a copy button, monospace lines, or badges.
import type { I18nText } from "@/i18n";

/** Text (a string), hex digits, monospace lines or tags; an empty one reads "(empty)". */
export type Value =
  string | { hex: string } | { lines: readonly string[] } | { tags: readonly string[] };

/** One label / value pair; an absent value reads "(empty)". */
export interface Row {
  label: string;
  value: Value | null | undefined;
  /** Tooltip of the label (e.g. the string type of a name attribute). */
  title?: string;
}

/** Rows; a `false` entry is an optional row that is absent. */
export const rows = (...list: (Row | false)[]): Row[] => list.filter((row) => row !== false);

/**
 * Rows labelled from one message group: rowOf<keyof typeof en.details.crl>(i18n, "details.crl")
 * gives row("crlNumber", value). With the type argument, a key missing from en.json does not
 * compile.
 */
export const rowOf =
  <K extends string>(i18n: Pick<I18nText, "t">, group: string) =>
  (key: K, value: Row["value"]): Row => ({ label: i18n.t(`${group}.${key}`), value });
