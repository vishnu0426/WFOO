// A copy of src/services/comboFilter.ts: this portal is built on its own. Keep the two in step.
/**
 * The rules behind a searchable list: which items a typed search keeps, in groups, and how the arrow keys move through what is shown. Pure functions (no React, no browser), tested on their own.
 */
export interface ComboItem { value: string; label: string; /** grey text on the right, e.g. "UTC+3 · 21:45" */ right?: string; /** extra words the search also looks in (a zone's full name, its offset) */ keywords?: string }
export interface ComboGroup { label: string; items: ComboItem[] }

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Every word typed must appear in the item's label, value, right-hand text or keywords. An empty search keeps everything. A value shown in two groups is listed once while searching. */
export function filterGroups(groups: ComboGroup[], query: string): ComboGroup[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const seen = new Set<string>(), out: ComboGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((i) => {
      if (seen.has(i.value)) return false;
      const hay = norm(`${i.label} ${i.value} ${i.right ?? ''} ${i.keywords ?? ''}`);
      if (!words.every((w) => hay.includes(w))) return false;
      seen.add(i.value); return true;
    });
    if (items.length) out.push({ label: g.label, items });
  }
  return out;
}

/** What is shown, in order, as one list (what the arrow keys walk through). */
export const flatten = (groups: ComboGroup[]): ComboItem[] => groups.flatMap((g) => g.items);

/** The next highlighted position after an arrow key, wrapping at both ends; -1 when there is nothing to highlight. */
export const step = (index: number, delta: 1 | -1, length: number): number => (length === 0 ? -1 : index < 0 ? (delta === 1 ? 0 : length - 1) : (index + delta + length) % length);

/** The label to show in the closed box for the chosen value (the value itself when it is not in the list). */
export function labelFor(groups: ComboGroup[], value: string): string {
  for (const g of groups) { const i = g.items.find((x) => x.value === value); if (i) return i.label; }
  return value;
}
