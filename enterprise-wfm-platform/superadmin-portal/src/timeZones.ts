// A copy of src/services/timeZones.ts: this portal is built on its own and cannot import from the main app. Keep the two in step.
/**
 * Time zones as people think of them: "Nairobi (UTC+3)" rather than "Africa/Nairobi", grouped by region, with the local time shown, a sensible default for a new WFM group (its site's zone,
 * else the organisation's) and a warning when a group is left on UTC although its site is somewhere else. Pure functions (no React, no browser state), tested on their own.
 */
import { ZONES, ZONE_ALIASES } from './zoneTable';

export interface ZoneChoice { id: string; city: string; region: string; offsetMin: number; label: string }

/** The zone's offset from UTC in minutes at this moment (daylight saving included), or 0 when the zone is not known. */
export function offsetMinutes(zone: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  } catch { return 0; }
}

/** "UTC+3", "UTC+5:30", "UTC-5", "UTC" */
export function offsetLabel(min: number): string {
  if (min === 0) return 'UTC';
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  return `UTC${min < 0 ? '-' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** "Africa/Nairobi" -> { city: "Nairobi", region: "Africa" }; "America/Argentina/Buenos_Aires" -> "Buenos Aires", "America" */
export function splitZone(id: string): { city: string; region: string } {
  const parts = id.split('/');
  if (parts.length === 1) return { city: id === 'UTC' ? 'UTC' : id.replace(/_/g, ' '), region: 'Other' };
  return { city: parts[parts.length - 1].replace(/_/g, ' '), region: parts[0] };
}

/** Every zone as a choice, by region then by offset then by city. */
export function zoneChoices(ids: string[], at: Date): ZoneChoice[] {
  return [...new Set(ids)].map((id) => {
    const { city, region } = splitZone(id), offsetMin = offsetMinutes(id, at);
    return { id, city, region, offsetMin, label: id === 'UTC' ? 'UTC' : `${city} (${offsetLabel(offsetMin)})` };
  }).sort((a, b) => a.region.localeCompare(b.region) || a.offsetMin - b.offsetMin || a.city.localeCompare(b.city));
}

/** The time of day in that zone, "21:45". Empty when the zone is not known. */
export function localTime(zone: string, at: Date): string {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at); } catch { return ''; }
}

/** The zone a new group starts on: its site's, else the organisation's, else UTC. */
export const defaultZone = (siteZone: string | null | undefined, orgZone: string | null | undefined): string => siteZone || orgZone || 'UTC';

/**
 * What to say about a group's zone: nothing when it is fine; a caution when it is UTC although the site (or, with no site, the organisation) is on another clock, because the group's days,
 * schedules and adherence then run hours away from where the people are.
 */
export function zoneNote(o: { zone: string; siteZone?: string | null; siteName?: string | null; orgZone?: string | null }): { kind: 'ok' | 'check'; text: string; suggest: string | null } {
  const zone = canonicalZone(o.zone), siteZone = o.siteZone ? canonicalZone(o.siteZone) : o.siteZone, orgZone = o.orgZone ? canonicalZone(o.orgZone) : o.orgZone;      // an old name for the same zone is not a mismatch
  const other = siteZone || orgZone || null;
  if (zone === 'UTC' && other && other !== 'UTC') {
    const where = siteZone ? `its site${o.siteName ? ` ${o.siteName}` : ''} is on ${other}` : `the organisation is on ${other}`;
    return { kind: 'check', text: `This group runs on UTC but ${where}. Shifts, forecast hours and adherence follow the group's clock.`, suggest: other };
  }
  if (siteZone && zone !== siteZone) return { kind: 'check', text: `The group is on ${zone}, its site${o.siteName ? ` ${o.siteName}` : ''} on ${siteZone}.`, suggest: siteZone };
  return { kind: 'ok', text: '', suggest: null };
}

// ---------------------------------------------------------------- the full list, with countries


/** The current name for a zone: an old name (Asia/Calcutta) becomes the modern one (Asia/Kolkata); anything else is returned as it is. */
export const canonicalZone = (id: string): string => ZONE_ALIASES[id] ?? id;

const validIds = new Map<string, boolean>();
const understood = (id: string): boolean => {
  let ok = validIds.get(id);
  if (ok === undefined) { try { new Intl.DateTimeFormat('en', { timeZone: id }); ok = true; } catch { ok = false; } validIds.set(id, ok); }
  return ok;
};
const legacyNames = (() => { const m = new Map<string, string[]>(); for (const [old, now] of Object.entries(ZONE_ALIASES)) m.set(now, [...(m.get(now) ?? []), old]); return m; })();
/** The name this browser understands for a zone: the current one, or (for an older browser that does not know it yet) an old name for the same zone. */
export const intlName = (id: string): string => (understood(id) ? id : (legacyNames.get(id) ?? []).find(understood) ?? id);

/** The country's name in English ("Kenya"), from the browser's own region names. */
export function countryName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

export interface ZoneEntry { id: string; city: string; region: string; country: string; countryName: string; offsetMin: number; label: string; time: string }

/** Every zone in the database: "Nairobi, Kenya (UTC+3)" with the time it is there now. By region, then country, then offset. UTC is the first entry. */
export function zoneList(at: Date): ZoneEntry[] {
  const names = new Map<string, string>();
  const name = (cc: string) => names.get(cc) ?? (names.set(cc, countryName(cc)), names.get(cc)!);
  const rows: ZoneEntry[] = ZONES.map(([id, cc]) => {
    const { city, region } = splitZone(id), use = intlName(id), offsetMin = offsetMinutes(use, at);
    return { id, city, region, country: cc, countryName: name(cc), offsetMin, label: `${city}, ${name(cc)} (${offsetLabel(offsetMin)})`, time: localTime(use, at) };
  }).sort((a, b) => a.region.localeCompare(b.region) || a.countryName.localeCompare(b.countryName) || a.offsetMin - b.offsetMin || a.city.localeCompare(b.city));
  return [{ id: 'UTC', city: 'UTC', region: 'Other', country: '', countryName: '', offsetMin: 0, label: 'UTC', time: localTime('UTC', at) }, ...rows];
}
