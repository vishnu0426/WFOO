/**
 * The choices behind the single sign-on pickers (scopes to ask for, which detail of the sign-in means "who they are" and "their groups"), kept apart from the
 * screen so they can be tested without a browser. No dependencies.
 */

export interface Seen { name: string; value: string; list: boolean }
export interface ClaimChoice { name: string; note?: string }

export const splitScopes = (value: string) => value.split(/[\s,]+/).filter(Boolean);
/** `openid` first and always present, no duplicates, in the order given. */
export const joinScopes = (list: string[]) => ['openid', ...list.filter((x, i) => x !== 'openid' && list.indexOf(x) === i)].join(' ');
export const toggleScope = (value: string, id: string) => { const have = splitScopes(value); return joinScopes(have.includes(id) ? have.filter((x) => x !== id) : [...have, id]); };
export const addScopes = (value: string, typed: string) => joinScopes([...splitScopes(value), ...splitScopes(typed)]);
export const removeScope = (value: string, id: string) => joinScopes(splitScopes(value).filter((x) => x !== id));
/** Scopes that are in the value but not in the provider's list: shown as their own chips so nothing saved is hidden. */
export const customScopes = (value: string, knownIds: string[]) => splitScopes(value).filter((x) => x !== 'openid' && !knownIds.includes(x));

const note = (c: Seen, kind: 'username' | 'group') => {
  if (kind === 'group') { const n = c.value.split(', ').filter(Boolean).length; return `${n} group${n === 1 ? '' : 's'}`; }
  if (c.name === 'sub') return 'an ID, not readable by people';
  return c.value.length > 28 ? `${c.value.slice(0, 28)}…` : c.value;
};

/**
 * The choices for a dropdown: after a sign-in has been tried, the details the provider really sent (single values for "who they are", lists for "their groups"),
 * each with an example; before that, the ones that provider usually sends. A value already saved that is not among them is added, so it is never lost.
 */
export function claimChoices(kind: 'username' | 'group', seen: Seen[], hints: string[], current: string): ClaimChoice[] {
  const out: ClaimChoice[] = seen.length
    ? seen.filter((c) => (kind === 'group' ? c.list : !c.list)).map((c) => ({ name: c.name, note: note(c, kind) }))
    : hints.map((n) => ({ name: n, note: kind === 'username' && n === 'sub' ? 'an ID, not readable by people' : undefined }));
  if (!seen.length && current && !out.some((o) => o.name === current)) out.push({ name: current });
  return out;
}
