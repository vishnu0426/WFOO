/**
 * Requirement per skill. The staffing engine pools a group's queues, so the group has one requirement per interval. When the group's queues
 * need different skills, that requirement is split between the skills by their share of the interval's workload (volume x handle time), so
 * the parts always add up to the pooled requirement. The scheduler then checks coverage skill by skill instead of as one headcount.
 */
import type { Tx } from '../db.ts';
import { versionRows } from './forecast/service.ts';
import { MAX_SKILLS, splitBySkill } from './skillSplit.ts';
export { MAX_SKILLS, splitBySkill };

const SPD = 96;

export interface SkillWork { skills: { id: string; name: string; work: number[] }[] }

/** The workload of each skill per slot over `days`, from the forecast the schedule is built on. Null unless two to MAX_SKILLS skills carry work. */
export async function loadSkillWork(tx: Tx, groupId: string, forecastVersionId: string, days: string[]): Promise<SkillWork | null> {
  const queues = await tx.q<{ id: string; skillId: string | null; skillName: string | null }>(
    `SELECT q.id, q.skill_id, s.name AS skill_name FROM queues q LEFT JOIN skills s ON s.id = q.skill_id WHERE q.tenant_id = :t AND q.wfm_group_id = $1`, [groupId]);
  if (new Set(queues.map((q) => q.skillId).filter(Boolean)).size < 2) return null;
  const skillOf = new Map(queues.filter((q) => q.skillId).map((q) => [q.id, q]));
  const rows = await versionRows(tx, forecastVersionId, { from: days[0], to: days[days.length - 1] });
  const di = new Map(days.map((d, i) => [d, i]));
  const by = new Map<string, { id: string; name: string; work: number[] }>();
  for (const r of rows) {
    const q = skillOf.get(r.queueId), i = di.get(r.day);
    if (!q || i === undefined) continue;
    const s = by.get(q.skillId!) ?? { id: q.skillId!, name: q.skillName ?? 'Skill', work: new Array(days.length * SPD).fill(0) };
    s.work[i * SPD + r.slot] += r.vol * r.aht;
    by.set(q.skillId!, s);
  }
  const skills = [...by.values()].filter((s) => s.work.some((v) => v > 0));
  return skills.length >= 2 && skills.length <= MAX_SKILLS ? { skills } : null;
}
