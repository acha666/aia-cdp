// Content-Security-Policy of the UI. The app sends it through secureHeaders on every response, so
// both runtimes serve the UI under the same policy; on JSON and downloads it changes nothing.
//
// The UI loads its scripts and styles from its own origin only: src/web/index.html has no inline
// script (light and dark follow prefers-color-scheme in CSS).
import { secureHeaders } from "hono/secure-headers";

/**
 * secureHeaders with Hono's defaults, the CSP below, and no Strict-Transport-Security.
 *
 * Inline styles stay blocked: Vue, Reka UI and vue-sonner set styles through the CSSOM
 * (element.style), which style-src does not govern. vue-i18n 11 interprets messages without eval,
 * so script-src needs no 'unsafe-eval' either.
 */
export const securityHeaders = secureHeaders({
  strictTransportSecurity: false,
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
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
  },
});
