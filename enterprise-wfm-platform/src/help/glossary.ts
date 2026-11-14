/** One definition per concept, reused wherever it is mentioned, so the wording never drifts between screens. */
export type HelpEntry = { title: string; body: string; example?: string };

export const GLOSSARY = {
  payWeek: { title: 'Pay week', body: 'The day your week starts for overtime and weekly limits. Weekly hours are added up from this day.', example: 'If the pay week starts on Monday, overtime is counted Monday to Sunday.' },
  wfmGroup: { title: 'WFM group', body: 'People who share a schedule. A group follows its site\'s time zone, holidays and labour-law pack.' },
  team: { title: 'Team', body: 'How people report and are organised. A team can have people from several sites.' },
  site: { title: 'Site', body: 'A place where people work. A site sets the time zone, public holidays and labour-law pack for its groups.' },
  region: { title: 'Region', body: 'An optional group of sites, such as EMEA. A labour-law pack set on a region applies to all its sites unless a site has its own.' },
  compliancePack: { title: 'Labour-law pack', body: 'A set of legal limits for a country, such as maximum weekly hours and rest between shifts. Schedules are checked against it.' },
  rotation: { title: 'Rotation pattern', body: 'A repeating cycle of work days and days off that a group of people follow, such as 4 days on and 3 off.' },
  crossSiteCover: { title: 'Cross-site cover', body: 'Lets people from one site work for a period at another site. They count towards the other site\'s cover and are not scheduled at their own.' },
  confidence: { title: 'How sure to be of having enough people', body: 'Higher settings plan for a busier day than the forecast, so cover holds more often, at the cost of more people on shift.', example: 'At 80, about 80 days in 100 are fully covered.' },
  solver: { title: 'Solver', body: 'The method that builds the schedule. Automatic tries the best one first and switches to a backup if it fails. All are open source, and the result says which one answered.' },
  solverTime: { title: 'Solver time', body: 'More time can find a better roster. Large groups need 60 seconds or more.' },
  alwaysEnforced: { title: 'Always enforced', body: 'These rules are never traded off: one shift a day, rest between shifts, weekly maximum, days in a row, days per week, availability, approved time off and template days.' },
  longSchedule: { title: 'Long schedules', body: 'A long schedule is built in the background, four weeks at a time, each starting where the one before ended. Weeks close to today are solved shift by shift. Weeks far ahead depend on a less certain forecast, so they repeat the last solved cycle and are re-solved as they come closer.' },
  gracePeriod: { title: 'Grace period', body: 'Extra days after a licence expires during which everything keeps working, so renewal never interrupts your operation.' },
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof GLOSSARY;
