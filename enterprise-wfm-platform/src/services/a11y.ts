/**
 * Screen-reader names for controls that show only an icon.
 *
 * A button holding just a picture has no name for a screen reader (WCAG 4.1.2). New buttons should carry an aria-label; this is the safety
 * net for every button that does not: it reads the button's tooltip (title), else the name of its icon, and sets aria-label from it.
 * Selects and inputs without a label get the same treatment from their placeholder or title.
 */
const ICON_WORDS: Record<string, string> = {
  x: 'Close', 'x-circle': 'Close', trash: 'Delete', 'trash-2': 'Delete', pencil: 'Edit', edit: 'Edit', 'edit-2': 'Edit', 'edit-3': 'Edit', plus: 'Add', 'plus-circle': 'Add', minus: 'Remove',
  'chevron-down': 'Expand', 'chevron-up': 'Collapse', 'chevron-left': 'Previous', 'chevron-right': 'Next', 'arrow-left': 'Back', 'arrow-right': 'Next', 'refresh-cw': 'Refresh',
  'rotate-ccw': 'Undo', 'rotate-cw': 'Redo', download: 'Download', upload: 'Upload', search: 'Search', filter: 'Filter', settings: 'Settings', 'settings-2': 'Settings', copy: 'Copy',
  eye: 'View', 'eye-off': 'Hide', check: 'Confirm', 'check-circle': 'Confirm', 'more-horizontal': 'More actions', 'more-vertical': 'More actions', play: 'Run', 'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out', save: 'Save', info: 'More information', 'help-circle': 'Help', bell: 'Notifications', calendar: 'Choose date', clock: 'Time', 'external-link': 'Open in new tab',
  link: 'Link', lock: 'Lock', unlock: 'Unlock', 'maximize-2': 'Expand', 'minimize-2': 'Collapse', 'panel-left': 'Toggle panel', menu: 'Menu',
};

function iconName(el: Element): string | null {
  const svg = el.querySelector('svg');
  if (!svg) return null;
  for (const c of Array.from(svg.classList)) if (c.startsWith('lucide-') && c !== 'lucide') return c.slice(7);
  return null;
}

function nameFor(el: HTMLElement): string | null {
  const title = el.getAttribute('title')?.trim();
  if (title) return title;
  const icon = iconName(el);
  if (icon) return ICON_WORDS[icon] ?? icon.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return null;
}

function label(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('button:not([aria-label]):not([aria-labelledby]), [role="button"]:not([aria-label]):not([aria-labelledby])').forEach((b) => {
    if (b.textContent?.trim()) return;
    const n = nameFor(b);
    if (n) b.setAttribute('aria-label', n);
  });
  root.querySelectorAll<HTMLElement>('select, textarea, input:not([type=hidden])').forEach((f) => {
    if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.getAttribute('role') === 'presentation') return;
    // already named by a <label> that wraps it or points at its id
    const wrapping = f.closest('label');
    if (wrapping && (wrapping.textContent ?? '').trim()) return;
    if (f.id && document.querySelector(`label[for="${CSS.escape(f.id)}"]`)) return;
    // a box in a table cell is named by its row and its column: "Schedule published" + "Email"
    const cell = f.closest('td');
    if (cell && cell.parentElement) {
      const row = cell.parentElement.querySelector('td, th')?.textContent?.trim();
      const col = cell.closest('table')?.querySelectorAll('thead th')[(cell as HTMLTableCellElement).cellIndex]?.textContent?.trim();
      if (row && cell !== cell.parentElement.querySelector('td, th')) { f.setAttribute('aria-label', [row, col].filter(Boolean).join(' - ').slice(0, 80)); return; }
    }
    // otherwise the nearest words that describe it: its tooltip, its placeholder, the text just before it, or the text on the chosen option of a list
    const before = (f.previousElementSibling?.textContent ?? f.parentElement?.previousElementSibling?.textContent ?? '').trim();
    const n = f.getAttribute('title') || f.getAttribute('placeholder') || before || f.getAttribute('name') || ((f as HTMLInputElement).type === 'file' ? 'Choose a file' : '') || ((f as HTMLInputElement).type === 'checkbox' ? 'Option' : '');
    if (n) f.setAttribute('aria-label', n.slice(0, 80));
  });
}

/** A box that scrolls must be reachable by keyboard (WCAG 2.1.1): one with nothing focusable inside it gets a tab stop so its content can be scrolled with the arrow keys. */
function focusableScrollers(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[class*="overflow-auto"], [class*="overflow-y-auto"], [class*="overflow-x-auto"]').forEach((el) => {
    if (el.hasAttribute('tabindex') || el.closest('.ag-root')) return;
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
    if (el.querySelector('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]')) return;
    el.setAttribute('tabindex', '0');
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) el.setAttribute('role', 'region'), el.setAttribute('aria-label', 'Scrollable content');
  });
}

export function installAutoLabels() {
  if (typeof document === 'undefined') return;
  let queued = false;
  const run = () => { queued = false; label(document); focusableScrollers(document); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true });
  run();
}
