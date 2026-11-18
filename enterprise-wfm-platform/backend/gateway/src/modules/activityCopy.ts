/**
 * Copying activity definitions from one workspace to another. Activities are matched by code (not by name or id), so copying twice never makes duplicates:
 * one that is not there yet is created, one that is identical is left alone, and one that differs is skipped or overwritten as the person chose.
 * This is the pure decision; the route does the reading and writing.
 */
export interface ActivityRow {
  id?: string; name: string; code: string; shortCode: string; category: string; countsAsWork: boolean; paid: boolean; shrinkage: boolean; ignoreAdherence: boolean;
  color: string; textColor: string | null; status: string;
}
export type OnExisting = 'SKIP' | 'OVERWRITE';
export interface CopyItem {
  code: string; name: string;
  /** What the target has: nothing, the same, something different, or another activity that already uses this name. */
  state: 'NEW' | 'SAME' | 'DIFFERS' | 'NAME_TAKEN';
  /** What will happen. */
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  /** For DIFFERS: which settings are not the same. */
  changes: string[];
  targetId: string | null;
}

const FIELDS: [keyof ActivityRow, string][] = [
  ['name', 'name'], ['shortCode', 'label'], ['category', 'type'], ['countsAsWork', 'queue work'], ['paid', 'paid'], ['shrinkage', 'shrinkage'],
  ['ignoreAdherence', 'adherence'], ['color', 'colour'], ['textColor', 'text colour'], ['status', 'status'],
];
const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v ?? null);

export function planCopy(source: ActivityRow[], target: ActivityRow[], onExisting: OnExisting): CopyItem[] {
  const byCode = new Map(target.map((t) => [t.code.toLowerCase(), t]));
  const byName = new Map(target.map((t) => [t.name.toLowerCase(), t]));
  return source.map((s): CopyItem => {
    const t = byCode.get(s.code.toLowerCase());
    if (!t) {
      const clash = byName.get(s.name.toLowerCase());
      return clash
        ? { code: s.code, name: s.name, state: 'NAME_TAKEN', action: 'SKIP', changes: [], targetId: clash.id ?? null }
        : { code: s.code, name: s.name, state: 'NEW', action: 'CREATE', changes: [], targetId: null };
    }
    const changes = FIELDS.filter(([k]) => norm(s[k]) !== norm(t[k])).map(([, label]) => label);
    if (!changes.length) return { code: s.code, name: s.name, state: 'SAME', action: 'SKIP', changes, targetId: t.id ?? null };
    // a rename would collide with a third activity that already has the new name
    const other = changes.includes('name') ? byName.get(s.name.toLowerCase()) : undefined;
    const blocked = !!other && other.code.toLowerCase() !== t.code.toLowerCase();
    return { code: s.code, name: s.name, state: 'DIFFERS', action: onExisting === 'OVERWRITE' && !blocked ? 'UPDATE' : 'SKIP', changes, targetId: t.id ?? null };
  });
}

/** One line for the result: "2 created, 1 updated, 3 already the same, 1 skipped". */
export function summarise(items: CopyItem[]): string {
  const n = (f: (i: CopyItem) => boolean) => items.filter(f).length;
  const parts = [
    [n((i) => i.action === 'CREATE'), 'created'], [n((i) => i.action === 'UPDATE'), 'updated'], [n((i) => i.state === 'SAME'), 'already the same'],
    [n((i) => i.state === 'DIFFERS' && i.action === 'SKIP'), 'left as they were (different)'], [n((i) => i.state === 'NAME_TAKEN'), 'skipped (name already used)'],
  ] as const;
  return parts.filter(([c]) => c > 0).map(([c, l]) => `${c} ${l}`).join(', ') || 'nothing to copy';
}
