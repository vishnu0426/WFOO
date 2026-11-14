/**
 * Rules behind the Pooling picker, with no React and no browser so they are tested on their own: which groups can be pooled on a day, searching them, quick choices (a whole site, a pair
 * that already shares people), how many can be picked, and the one-sentence answer.
 */
export interface Cand { id: string; name: string; siteId: string | null; siteName: string | null; queues: number; channels: string[]; people: number; ready: boolean; forecastName: string | null }
export interface Pair { a: string; b: string; people: number }
export const MAX_POOL = 8;

/** Groups with a published short-term forecast for the day can be compared; the rest cannot, and are only listed. */
export function split(cands: Cand[]): { ready: Cand[]; notReady: Cand[] } {
  return { ready: cands.filter((c) => c.ready), notReady: cands.filter((c) => !c.ready) };
}
const words = (c: Cand) => `${c.name} ${c.siteName ?? ''} ${c.channels.join(' ')}`.toLowerCase();
export const search = (list: Cand[], query: string): Cand[] => {
  const t = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return t.length ? list.filter((c) => t.every((w) => words(c).includes(w))) : list;
};

export interface SiteChoice { siteId: string; name: string; ids: string[]; more: number }
/** A site with two or more groups that can be pooled: one click picks them (up to the limit). */
export function siteChoices(ready: Cand[]): SiteChoice[] {
  const by = new Map<string, Cand[]>();
  for (const c of ready) if (c.siteId && c.siteName) by.set(c.siteId, [...(by.get(c.siteId) ?? []), c]);
  return [...by.entries()].filter(([, l]) => l.length >= 2).map(([siteId, l]) => ({ siteId, name: l[0].siteName!, ids: l.slice(0, MAX_POOL).map((c) => c.id), more: Math.max(0, l.length - MAX_POOL) }))
    .sort((x, y) => y.ids.length - x.ids.length || x.name.localeCompare(y.name));
}

export interface Suggestion { ids: [string, string]; label: string; people: number }
/** Pairs of groups that already share people, the likeliest to gain from one pool. Only pairs that can be compared on the day. */
export function suggestions(ready: Cand[], pairs: Pair[], limit = 5): Suggestion[] {
  const byId = new Map(ready.map((c) => [c.id, c]));
  return pairs.filter((p) => byId.has(p.a) && byId.has(p.b)).sort((x, y) => y.people - x.people).slice(0, limit)
    .map((p) => ({ ids: [p.a, p.b], label: `${byId.get(p.a)!.name} + ${byId.get(p.b)!.name}`, people: p.people }));
}

/** Add or take away one group; at the limit nothing more is added. */
export function toggle(picked: string[], id: string): { picked: string[]; full: boolean } {
  if (picked.includes(id)) return { picked: picked.filter((x) => x !== id), full: false };
  if (picked.length >= MAX_POOL) return { picked, full: true };
  return { picked: [...picked, id], full: false };
}
/** Pick a set at once (a site, a suggested pair): kept to the limit, and merged with what is picked already. */
export const pickMany = (picked: string[], ids: string[]): string[] => [...new Set([...picked, ...ids])].slice(0, MAX_POOL);
export const whyNot = (n: number): string => (n < 2 ? 'Pick at least two groups to compare.' : '');
export const channelWords = (channels: string[]): string => channels.map((c) => c.toLowerCase()).join(', ');

const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
export interface PoolResult { groups: { name: string }[]; savingHours: number; savingPercent: number; peakSeparate: number; peakPooled: number }
/** What pooling does, in one sentence. */
export function headline(r: PoolResult): string {
  const names = list(r.groups.map((g) => g.name));
  if (r.savingHours <= 0.05) return `Pooling ${names} gives no gain on this day: kept apart they already meet the target as well.`;
  const peak = Math.round(r.peakSeparate - r.peakPooled);
  return `Pooling ${names} needs ${Math.round(r.savingHours).toLocaleString('en')} fewer agent hours on the day (−${Math.round(r.savingPercent)}%)${peak > 0 ? `, and ${peak} fewer ${peak === 1 ? 'agent' : 'agents'} at the busiest time` : ''}.`;
}
