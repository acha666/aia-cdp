// The values of the UI's label / value lists (KeyValueList) and extension bodies, each drawn by
// ValueView in exactly one way: text, grouped hex with a copy button, monospace lines, or badges.

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
