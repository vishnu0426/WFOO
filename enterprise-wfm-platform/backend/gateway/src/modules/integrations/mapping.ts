/**
 * The mapping layer shared by every connector: field mapping turns a raw vendor payload into our shape (this is the
 * generic, reusable half of "flexible"), and entity matching turns a vendor's own queue/employee identifiers into
 * ours (this is the half that genuinely cannot be guessed and always needs a human's one-time confirmation).
 */

export type Transform = 'ms_to_s' | 'minutes_to_s' | null | undefined;

/** A dotted path into a plain object/array structure, e.g. "data.stats.nOffered" or "Collections.0.Value". */
export function getByPath(obj: any, path: string): unknown {
  return path.split('.').reduce((cur, key) => (cur === null || cur === undefined ? undefined : cur[key]), obj);
}

export function applyTransform(value: unknown, transform: Transform): unknown {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  if (transform === 'ms_to_s' && Number.isFinite(n)) return n / 1000;
  if (transform === 'minutes_to_s' && Number.isFinite(n)) return n * 60;
  return value;
}

export interface FieldMap { targetField: string; sourcePath: string; transform?: Transform }

/** Runs one raw vendor record through its connector's field maps, producing a plain {targetField: value} object. */
export function mapFields(raw: unknown, maps: FieldMap[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of maps) out[m.targetField] = applyTransform(getByPath(raw, m.sourcePath), m.transform);
  return out;
}

// ---------------------------------------------------------------- entity matching

export interface EntityCandidate { id: string; name: string; code?: string }
export interface EntitySeen { sourceId: string; sourceLabel: string }
export interface EntitySuggestion { sourceId: string; sourceLabel: string; targetId: string | null; targetName: string | null; score: number }

const normalize = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Token-overlap similarity: fast, dependency-free, good enough for "Support Voice" vs "support-voice-queue". */
function similarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? shared / union : 0;
  const substr = na.includes(nb) || nb.includes(na) ? 0.3 : 0;
  return Math.min(1, jaccard + substr);
}

/** For each identifier seen in a vendor's data, the best-scoring match among our own candidates (queues/employees/skills), or none below a confidence floor. */
export function suggestEntityMatches(seen: EntitySeen[], candidates: EntityCandidate[], floor = 0.34): EntitySuggestion[] {
  return seen.map((s) => {
    let best: EntityCandidate | null = null, bestScore = 0;
    for (const c of candidates) {
      const score = Math.max(similarity(s.sourceLabel, c.name), c.code ? similarity(s.sourceLabel, c.code) : 0, similarity(s.sourceId, c.name));
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return { sourceId: s.sourceId, sourceLabel: s.sourceLabel, targetId: bestScore >= floor ? best!.id : null, targetName: bestScore >= floor ? best!.name : null, score: Math.round(bestScore * 100) / 100 };
  });
}
