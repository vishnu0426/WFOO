/**
 * Skill coverage risk, as a pure function so every rule can be tested: is this skill held by enough people who can actually be scheduled?
 *
 * "Held" counts people who are ACTIVE (someone who has left, is suspended or is still onboarding cannot take a shift). A skill that a WFM group requires is judged by the people who are
 * qualified for that group, meaning eligible for it and at or above the level it asks for, because that is who the scheduler can really use. NONE is nobody; THIN is fewer than the threshold.
 *
 * The reason says WHY, because "nobody" next to a person who holds the skill is confusing: the person may simply not be eligible for the group (`outsideQualified`), or people in the group may
 * have the skill below the level asked for (`inGroupHolders`). `fixGroupId` is the group the fix dialog should open on.
 */
export interface RequiredBy {
  groupId: string; groupName: string; minProficiency: number; qualified: number;
  outsideQualified?: number;      // active people who hold it at the level asked for but are not eligible for this group
  inGroupHolders?: number;        // active people eligible for this group who hold it at any level
}
export type RiskLevel = 'NONE' | 'THIN' | 'OK';
export interface Risk { level: RiskLevel; reason: string | null; requiredByGroups: number; fixGroupId: string | null }

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const levelText = (min: number) => (min > 1 ? ` at level ${min} or higher` : '');

/** Why a group has nobody qualified, in the terms a planner can act on. */
function whyNobody(r: RequiredBy): string {
  const outside = r.outsideQualified ?? 0, inGroup = r.inGroupHolders ?? 0;
  if (outside > 0) return `${people(outside)} ${outside === 1 ? 'has' : 'have'} it${levelText(r.minProficiency)} but ${outside === 1 ? 'is' : 'are'} not eligible for ${r.groupName}, which requires it`;
  if (inGroup > 0) return `${people(inGroup)} in ${r.groupName} ${inGroup === 1 ? 'has' : 'have'} it, but below level ${r.minProficiency}, which ${r.groupName} requires`;
  return `Nobody in ${r.groupName} has it${levelText(r.minProficiency)}, and ${r.groupName} requires it`;
}

export function riskOf(s: { activeHolders: number; requiredBy: RequiredBy[] }, threshold: number): Risk {
  const need = Math.max(1, Math.floor(threshold));
  const req = s.requiredBy;
  const none = req.find((r) => r.qualified === 0);
  if (none) return { level: 'NONE', reason: whyNobody(none), requiredByGroups: req.length, fixGroupId: none.groupId };
  if (s.activeHolders === 0) return { level: 'NONE', reason: req.length ? 'Nobody who can work holds it' : 'Nobody holds it. No group requires it, so nothing is affected yet', requiredByGroups: req.length, fixGroupId: req[0]?.groupId ?? null };
  const thinGroup = req.filter((r) => r.qualified < need).sort((a, b) => a.qualified - b.qualified)[0];
  if (thinGroup) {
    const more = thinGroup.outsideQualified ?? 0;
    return { level: 'THIN', reason: `Only ${people(thinGroup.qualified)} ${thinGroup.qualified === 1 ? 'is' : 'are'} qualified for ${thinGroup.groupName}${levelText(thinGroup.minProficiency)}${more > 0 ? `; ${people(more)} more ${more === 1 ? 'has' : 'have'} it but ${more === 1 ? 'is' : 'are'} not eligible for it` : ''}`, requiredByGroups: req.length, fixGroupId: thinGroup.groupId };
  }
  if (s.activeHolders < need) return { level: 'THIN', reason: `Only ${people(s.activeHolders)} can work it`, requiredByGroups: req.length, fixGroupId: null };
  return { level: 'OK', reason: null, requiredByGroups: req.length, fixGroupId: null };
}
