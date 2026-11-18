/**
 * The file used to move configuration between environments (test to production, one customer's setup to another): a plain JSON "configuration pack".
 * Today it carries activity definitions and the phone-state (RTA) mapping rows that point at them; `format` and `version` let it carry more later, and let an older
 * server refuse a file written by a newer one instead of misreading it.
 */
import { z } from 'zod';

export const PACK_FORMAT = 'agnowfm-config';
export const PACK_VERSION = 1;

const hex = /^#[0-9a-fA-F]{6}$/;
const PackActivity = z.object({
  name: z.string().trim().min(1).max(80), code: z.string().trim().min(1).max(30), shortCode: z.string().trim().max(4).default(''),
  category: z.enum(['WORK', 'BREAK', 'MEAL', 'TRAINING', 'MEETING', 'COACHING', 'ABSENCE', 'OTHER']),
  countsAsWork: z.boolean(), paid: z.boolean(), shrinkage: z.boolean(), ignoreAdherence: z.boolean().default(false),
  color: z.string().regex(hex, 'must look like #8AA4C8'), textColor: z.string().regex(hex, 'must look like #171717').nullable().default(null), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
const PackRta = z.object({ state: z.string().trim().min(1).max(200), reason: z.string().trim().max(200).default(''), activityCode: z.string().trim().min(1).max(30) });
const Pack = z.object({
  format: z.literal(PACK_FORMAT), version: z.number().int().min(1),
  exportedAt: z.string().max(40).optional(), source: z.object({ workspace: z.string().max(200).optional() }).optional(),
  activities: z.array(PackActivity).max(300), rtaMapping: z.array(PackRta).max(2000).default([]),
});
export type ConfigPack = z.infer<typeof Pack>;

export interface PackSource { name: string; code: string; shortCode: string; category: string; countsAsWork: boolean; paid: boolean; shrinkage: boolean; ignoreAdherence: boolean; color: string; textColor: string | null; status: string }

/** The file's content for these activities (and, when asked, the phone-state rows that point at them). */
export function buildPack(activities: PackSource[], rta: { state: string; reason: string; activityCode: string }[], workspaceName: string, now = new Date()): ConfigPack {
  return {
    format: PACK_FORMAT, version: PACK_VERSION, exportedAt: now.toISOString(), source: { workspace: workspaceName },
    activities: activities.map((a) => ({ name: a.name, code: a.code, shortCode: a.shortCode, category: a.category as ConfigPack['activities'][number]['category'], countsAsWork: a.countsAsWork, paid: a.paid, shrinkage: a.shrinkage, ignoreAdherence: a.ignoreAdherence, color: a.color, textColor: a.textColor ?? null, status: a.status as 'ACTIVE' | 'INACTIVE' })),
    rtaMapping: rta,
  };
}

/** Reads an uploaded file's content, or throws an Error whose message says in plain words what is wrong with it. */
export function readPack(raw: unknown): ConfigPack {
  const o = raw as { format?: unknown; version?: unknown } | null;
  if (!o || typeof o !== 'object' || o.format !== PACK_FORMAT) throw new Error('This is not an AgnoWFM configuration file. Export one from Activity Definitions and use that.');
  if (typeof o.version === 'number' && o.version > PACK_VERSION) throw new Error(`This file was made by a newer version of AgnoWFM (file version ${o.version}, this server reads up to ${PACK_VERSION}). Update this environment first.`);
  const r = Pack.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    const where = i.path.length ? i.path.map((p) => (typeof p === 'number' ? `#${p + 1}` : p)).join(' › ') : 'the file';
    throw new Error(`The file could not be read: ${where} ${i.message}.`);
  }
  const seen = new Set<string>();
  for (const a of r.data.activities) {
    const k = a.code.toLowerCase();
    if (seen.has(k)) throw new Error(`The file lists the activity code ${a.code} twice.`);
    seen.add(k);
  }
  const unknown = r.data.rtaMapping.find((m) => !seen.has(m.activityCode.toLowerCase()));
  if (unknown) throw new Error(`A phone-state mapping row (${unknown.state}) points at the activity ${unknown.activityCode}, which is not in the file.`);
  return { ...r.data, activities: r.data.activities.map((a) => ({ ...a, shortCode: a.shortCode || a.name.slice(0, 2).toUpperCase() })) };
}
