// Shared by the PKI core tests (and the import / publish tests of slices 2 and 4).
import * as pkijs from "pkijs";
import { PkiParseError } from "../../src/core/pki/errors.ts";
import type { PkiKind, PkiParseReason } from "../../src/core/pki/errors.ts";

/**
 * `{ kind, reason }` of the PkiParseError that `run` throws or rejects with, so a test compares
 * both at once. Anything else (another error, no error) fails the test.
 */
export async function pkiError(
  run: () => unknown
): Promise<{ kind: PkiKind; reason: PkiParseReason }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PkiParseError) {
      return { kind: error.kind, reason: error.reason };
    }
    throw error;
  }
  throw new Error("Expected a PkiParseError, but nothing was thrown");
}

/** An X.509 extension whose extnValue is the DER of `value` (an asn1js block or PKIjs schema). */
export function extension(
  oid: string,
  value: { toBER(sizeOnly?: boolean): ArrayBuffer }
): pkijs.Extension {
  return new pkijs.Extension({ extnID: oid, extnValue: value.toBER(false) });
}
