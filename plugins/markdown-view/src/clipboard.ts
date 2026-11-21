// Text to the clipboard. The async API where the page may use it; the old copy
// command where a webview or a plain-http page withholds it.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    // Off screen but real: iOS selects and copies only what is rendered, and 16px keeps it from zooming in.
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}
