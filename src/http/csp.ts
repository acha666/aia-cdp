// Content-Security-Policy of the UI (implementation slice 5b step 10, owner answer 1). The app
// sends it through secureHeaders on every response, so both runtimes serve the UI under the same
// policy; on JSON and downloads it changes nothing.
//
// The UI loads its scripts and styles from its own origin only. The one exception is the pre-paint
// theme script inlined in src/web/index.html (no light flash before the bundle runs), allowed by
// its sha256. Vite copies that script byte for byte into dist/web/index.html, so the hash below
// holds for the build as well; tests/http/csp.test.ts recomputes it from the source file. Change
// the script and its hash together.
import type { secureHeaders } from "hono/secure-headers";

type ContentSecurityPolicy = NonNullable<
  NonNullable<Parameters<typeof secureHeaders>[0]>["contentSecurityPolicy"]
>;

/** CSP source expressions of the inline scripts in src/web/index.html. */
export const INLINE_SCRIPT_HASHES: readonly string[] = [
  "'sha256-lMXjpKW1cv/Tm9LneyT9fSBQ1EyOmxyBXvg1HobwoVA='",
];

/**
 * Inline styles stay blocked: Vue, Reka UI and vue-sonner set styles through the CSSOM
 * (element.style), which style-src does not govern, and ThemeToggle's useColorMode runs without
 * the <style> element of its disableTransition option. vue-i18n 11 interprets messages without
 * eval, so script-src needs no 'unsafe-eval' either.
 */
export const CONTENT_SECURITY_POLICY: ContentSecurityPolicy = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", ...INLINE_SCRIPT_HASHES],
  styleSrc: ["'self'"],
  // An image cannot run script; data: leaves room for inlined icons (the build has none today).
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  // As X-Frame-Options: SAMEORIGIN, which secureHeaders sends as well.
  frameAncestors: ["'self'"],
  // The upload card's form never submits itself (@submit.prevent, then fetch).
  formAction: ["'none'"],
};
