/**
 * Escape closes the pop-up that is open on top, in every screen, however it was written. A pop-up always has its own Cancel / Close / Done button; this presses it, so the
 * same clean-up runs as when someone clicks it. Pop-ups that already listen for Escape themselves (role="dialog": confirmations, the command palette, the trace) are left to do so.
 */
const DISMISS = /^(cancel|close|done|dismiss|not now|back|no)\b/i;

export function dismissTopModal(): boolean {
  const layers = [...document.querySelectorAll<HTMLElement>('div.fixed.inset-0')].filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  const top = layers.at(-1);
  if (!top || top.getAttribute('role') === 'dialog') return false;
  const buttons = [...top.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  const target = [...buttons].reverse().find((b) => b.getAttribute('aria-label')?.toLowerCase() === 'close' || DISMISS.test((b.textContent ?? '').trim()));
  if (!target) return false;
  target.click();
  return true;
}

export function installModalDismiss(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && /^(select)$/i.test(a.tagName)) return;                 // Escape inside an open drop-down belongs to the drop-down
    if (dismissTopModal()) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
