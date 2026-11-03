/**
 * Pure rules for WFM group administration: which edits change staffing or pay numbers (and so need a reason), tidy queue aliases, and read a
 * file of groups and queues. No database here, so each rule is tested on its own.
 */

/** Changing any of these changes staffing numbers, weekly hour counts or what existing schedules mean, so the person must say why. */
export const IMPACT_FIELDS = {
  serviceLevelGoal: 'service level goal', serviceLevelThresholdSec: 'answer-within time', targetOccupancy: 'occupancy cap', shrinkagePercent: 'shrinkage',
  method: 'staffing method', patienceSec: 'customer patience', blended: 'blended pool', fteHoursWeek: 'full-time hours', payWeekStart: 'pay week start',
  timezone: 'time zone', status: 'status',
} as const;

/** Plain-language names of the impact fields this edit really changes (a value sent back unchanged does not count). */
export function impactChanges(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return (Object.entries(IMPACT_FIELDS) as [string, string][])
    .filter(([k]) => k in patch && patch[k] !== undefined && (patch[k] ?? null) !== (before[k] ?? null))
    .map(([, label]) => label);
}

/** Trim, drop blanks and repeats (case ignored), keep the order. */
export function cleanAliases(list: string[] | undefined | null): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const a of list ?? []) {
    const v = a.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}

/** The fields that differ between two group snapshots, as {field, from, to}: what the history shows. */
export function diffFields(before: Record<string, any> | null, after: Record<string, any> | null, skip = ['updatedAt', 'createdAt', 'queueIds', 'queueNames', 'channels', 'agentCount', 'managerId']) {
  if (!before || !after) return [] as { field: string; from: unknown; to: unknown }[];
  return Object.keys(after).filter((k) => !skip.includes(k) && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => ({ field: k, from: before[k] ?? null, to: after[k] ?? null }));
}

// ---------------------------------------------------------------- a file of groups and their queues

export interface GroupFileQueue { name: string; channel: 'VOICE' | 'CHAT' | 'EMAIL' | 'BACKOFFICE'; ahtDefault: number; aliases: string[]; line: number }
export interface GroupFileGroup {
  name: string; description: string; timezone: string | null; site: string | null; line: number;
  serviceLevelGoal?: number; serviceLevelThresholdSec?: number; shrinkagePercent?: number; targetOccupancy?: number; queues: GroupFileQueue[];
}
export const GROUP_FILE_TEMPLATE = 'group,description,site,timezone,service_level_goal,answer_seconds,shrinkage_percent,occupancy_cap,queue,channel,handle_time_sec,queue_aliases\n'
  + 'Technical support,Tier 1 phone and chat,Chennai,Asia/Kolkata,80,20,30,85,Tech voice,VOICE,420,TS_VOICE|Tech Support Voice\n'
  + 'Technical support,,,,,,,,Tech chat,CHAT,600,\n';

const HEADS: Record<string, string[]> = {
  group: ['group', 'group_name', 'wfm_group', 'name'], description: ['description'], site: ['site', 'site_name'], timezone: ['timezone', 'time_zone'],
  serviceLevelGoal: ['service_level_goal', 'service_level', 'sl'], answerSec: ['answer_seconds', 'answer_within', 'threshold_sec'],
  shrinkage: ['shrinkage_percent', 'shrinkage'], occupancy: ['occupancy_cap', 'occupancy', 'target_occupancy'],
  queue: ['queue', 'queue_name'], channel: ['channel'], aht: ['handle_time_sec', 'aht', 'handle_time'], aliases: ['queue_aliases', 'aliases'],
};
const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/** Rows are one per queue (the group columns repeat or are left blank after the first row of a group). */
export function parseGroupFile(matrix: string[][]): { groups: GroupFileGroup[]; errors: { line: number; message: string }[] } {
  const errors: { line: number; message: string }[] = [];
  if (matrix.length < 2) return { groups: [], errors: [{ line: 1, message: 'The file has a header but no data rows.' }] };
  const header = matrix[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col: Record<string, number> = {};
  for (const [k, names] of Object.entries(HEADS)) col[k] = header.findIndex((h) => names.includes(h));
  if (col.group < 0) return { groups: [], errors: [{ line: 1, message: `No group column (expected one of: ${HEADS.group.join(', ')}).` }] };
  const cell = (r: string[], k: string) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
  const num = (r: string[], k: string, lo: number, hi: number, label: string, line: number): number | undefined => {
    const v = cell(r, k); if (v === '') return undefined;
    const n = Number(v.replace(/%$/, ''));
    if (!Number.isFinite(n) || n < lo || n > hi) { errors.push({ line, message: `${label} '${v}' must be a number from ${lo} to ${hi}.` }); return undefined; }
    return n;
  };
  const groups = new Map<string, GroupFileGroup>();
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i], line = i + 1;
    if (r.every((c) => !String(c ?? '').trim())) continue;
    const name = cell(r, 'group');
    if (!name) { errors.push({ line, message: 'The group name is empty.' }); continue; }
    if (name.length > 80) { errors.push({ line, message: `The group name '${name.slice(0, 20)}…' is longer than 80 characters.` }); continue; }
    let g = groups.get(name.toLowerCase());
    if (!g) {
      const tz = cell(r, 'timezone');
      if (tz && !validZone(tz)) errors.push({ line, message: `'${tz}' is not a time zone (for example Asia/Kolkata or Europe/London).` });
      g = { name, description: cell(r, 'description'), timezone: tz || null, site: cell(r, 'site') || null, line, queues: [],
        serviceLevelGoal: num(r, 'serviceLevelGoal', 1, 99, 'Service level goal', line), serviceLevelThresholdSec: num(r, 'answerSec', 1, 600, 'Answer within', line),
        shrinkagePercent: num(r, 'shrinkage', 0, 90, 'Shrinkage', line), targetOccupancy: num(r, 'occupancy', 31, 100, 'Occupancy cap', line) };
      groups.set(name.toLowerCase(), g);
    }
    const qn = cell(r, 'queue');
    if (!qn) continue;
    const channel = (cell(r, 'channel') || 'VOICE').toUpperCase();
    if (!['VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'].includes(channel)) { errors.push({ line, message: `Channel '${channel}' must be VOICE, CHAT, EMAIL or BACKOFFICE.` }); continue; }
    const aht = num(r, 'aht', 1, 7200, 'Handle time', line) ?? 300;
    if (g.queues.some((q) => q.name.toLowerCase() === qn.toLowerCase())) { errors.push({ line, message: `The queue '${qn}' is listed twice in ${g.name}.` }); continue; }
    g.queues.push({ name: qn, channel: channel as GroupFileQueue['channel'], ahtDefault: Math.round(aht), aliases: cleanAliases(cell(r, 'aliases').split('|')), line });
  }
  return { groups: [...groups.values()], errors };
}
