// Copying text to the clipboard (CopyButton). The Clipboard API needs a secure context and
// may be denied; the fallback copies a selected off-screen <textarea> with
// document.execCommand("copy"), which answers false when the browser refuses. vueuse's
// useClipboard ignores that answer and reports every fallback as copied, so a failure could never
// reach the user; this helper throws instead.

/** Puts `text` on the clipboard; throws when neither way worked. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // No Clipboard API (no secure context), denied, or no user activation the API accepts: try
    // the fallback.
  }
  if (!legacyCopy(text)) {
    throw new Error("The browser refused to copy to the clipboard.");
  }
}

/** false when the browser refuses, or has no execCommand (it throws then). */
function legacyCopy(text: string): boolean {
  // Selecting the textarea takes the focus; it goes back to the copy button afterwards.
  const active = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  // CSSOM, not a style attribute: the CSP's style-src has no 'unsafe-inline'.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (active instanceof HTMLElement) {
      active.focus({ preventScroll: true });
    }
  }
}
