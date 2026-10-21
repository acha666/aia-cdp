// Hex display helpers, from worker-aia-cdp@5b570aa:src/web/utils/format.ts. copyToClipboard
// (document.execCommand) is gone: HexValue copies through useClipboard.

interface HexFormatOptions {
  /** Characters per group; 0 or less: one group. Default 2 (one byte). */
  groupSize?: number;
  /** Between groups; default ":". */
  separator?: string;
  /** Default true. */
  uppercase?: boolean;
}

/** "0a1b2c" → "0A:1B:2C". */
export function formatHex(hex: string, options: HexFormatOptions = {}): string {
  const separator = options.separator ?? ":";
  return formatHexGroups(hex, options).join(separator);
}

/** "0a1b2c" → ["0A", "1B", "2C"]; the last group may be shorter. */
export function formatHexGroups(hex: string, options: HexFormatOptions = {}): string[] {
  const groupSize = options.groupSize ?? 2;
  const uppercase = options.uppercase ?? true;
  const value = uppercase ? hex.toUpperCase() : hex;
  if (groupSize <= 0) {
    return [value];
  }
  return value.match(new RegExp(`.{1,${String(groupSize)}}`, "g")) ?? [];
}

/** The hex digits of a displayed value, for the clipboard: no 0x, colons, spaces or dashes. */
export function normalizeHexForCopy(hex: string): string {
  const trimmed = hex.trim();
  const noPrefix =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  return noPrefix.replace(/[:\s-]/g, "").toUpperCase();
}
