/**
 * Starter labour-law packs by country. Each one is the main working-time rules of a country's labour law, written as data in the rule types of the catalogue
 * (rules.ts). They are STARTERS: the figures are the general statutory ones, written from the law's usual summary, and they have not been reviewed by a
 * local lawyer. Collective agreements, sector rules, awards and regional rules often differ, and some rules (a 36-hour weekly rest, overtime caps, Sunday
 * pay) have no rule type yet: each pack says what it does not cover. An organisation copies a pack, checks it against its own situation, and adjusts it.
 *
 * Severity: BLOCK where the law sets a hard limit that overtime cannot lift (rest, spread-over, daily cap, meal interval, days in a row); WARN where the figure is
 * an ordinary-hours threshold that overtime may legally exceed, so it is reported (and the overtime premium shown) without stopping a schedule.
 * Pure data: rules.ts normalises it.
 */
export type CountryRule = { type: 'MAX_DAILY_HOURS' | 'MAX_WEEKLY_HOURS' | 'MAX_SPREAD_HOURS' | 'MIN_DAILY_REST_HOURS' | 'MAX_CONSECUTIVE_DAYS' | 'MIN_DAYS_OFF_TOGETHER' | 'MIN_WEEKENDS_OFF_MONTH' | 'MEAL_BREAK' | 'NIGHT_WORK' | 'OVERTIME_PREMIUM' | 'MIN_NOTICE_DAYS'; params: Record<string, number | string | boolean>; severity: 'BLOCK' | 'WARN' };
export interface CountryPack { code: string; name: string; region: string; law: string; description: string; notes: string; rules: CountryRule[] }

const daily = (hours: number, severity: 'BLOCK' | 'WARN' = 'WARN'): CountryRule => ({ type: 'MAX_DAILY_HOURS', params: { hours }, severity });
const weekly = (hours: number, severity: 'BLOCK' | 'WARN' = 'WARN'): CountryRule => ({ type: 'MAX_WEEKLY_HOURS', params: { hours }, severity });
const spread = (hours: number): CountryRule => ({ type: 'MAX_SPREAD_HOURS', params: { hours }, severity: 'BLOCK' });
const rest = (hours: number, severity: 'BLOCK' | 'WARN' = 'BLOCK'): CountryRule => ({ type: 'MIN_DAILY_REST_HOURS', params: { hours }, severity });
const days = (n: number): CountryRule => ({ type: 'MAX_CONSECUTIVE_DAYS', params: { days: n }, severity: 'BLOCK' });
const meal = (afterHours: number, minutes: number, severity: 'BLOCK' | 'WARN' = 'BLOCK'): CountryRule => ({ type: 'MEAL_BREAK', params: { afterHours, minutes }, severity });
const overtime = (afterDailyHours: number, afterWeeklyHours: number, multiplier: number): CountryRule => ({ type: 'OVERTIME_PREMIUM', params: { afterDailyHours, afterWeeklyHours, multiplier }, severity: 'WARN' });

export const COUNTRY_PACKS: CountryPack[] = [
  // ---- Africa
  { code: 'NA_LABOUR_2007', name: 'Namibia: Labour Act 2007', region: 'Namibia', law: 'Labour Act 11 of 2007',
    description: 'Ordinary hours 45 a week and 9 a day (8 on a six-day week); overtime up to 3 hours a day and 10 a week, paid at 1.5 times; a meal interval of an hour after 5 hours.',
    notes: 'Not covered: the 36-hour weekly rest, night-work conditions (20:00 to 07:00), and the double pay for Sundays and public holidays. The caps here are the ordinary hours plus the permitted overtime.',
    rules: [daily(9), daily(12, 'BLOCK'), weekly(45), weekly(55, 'BLOCK'), meal(5, 60), days(6), overtime(9, 45, 1.5)] },
  { code: 'ZA_BCEA', name: 'South Africa: Basic Conditions of Employment Act', region: 'South Africa', law: 'Basic Conditions of Employment Act 75 of 1997',
    description: 'Ordinary hours 45 a week and 9 a day (8 on a six-day week); overtime at most 10 hours a week, paid at 1.5 times; an hour for a meal after 5 hours; 12 hours daily rest.',
    notes: 'Not covered: the 36-hour weekly rest, night-work allowance and transport (18:00 to 06:00), and Sunday and public-holiday pay. Sector determinations and bargaining council agreements can differ.',
    rules: [daily(9), daily(12, 'BLOCK'), weekly(45), weekly(55, 'BLOCK'), rest(12), meal(5, 60), days(6), overtime(9, 45, 1.5)] },
  { code: 'EG_LABOUR_2003', name: 'Egypt: Labour Law 2003', region: 'Egypt', law: 'Labour Law 12 of 2003',
    description: 'Normal hours 8 a day and 48 a week; no more than 10 hours from start to finish including breaks; at least an hour of rest after no more than 5 hours of work; a weekly rest day.',
    notes: 'Not covered: overtime caps and the day and night overtime premiums (35% and 70%), and Ramadan hours.',
    rules: [daily(8), weekly(48), spread(10), meal(5, 60), days(6)] },

  // ---- Middle East
  { code: 'AE_LABOUR_2021', name: 'United Arab Emirates: Labour Law 2021', region: 'United Arab Emirates', law: 'Federal Decree-Law 33 of 2021',
    description: 'Normal hours 8 a day and 48 a week; a break of at least an hour after 5 hours; overtime up to 2 hours a day, paid at 1.25 times.',
    notes: 'Not covered: reduced hours in Ramadan, the higher night premium (22:00 to 04:00), and the weekly rest day rules. Free-zone and government rules differ.',
    rules: [daily(8), daily(10, 'BLOCK'), weekly(48), meal(5, 60), days(6), overtime(8, 48, 1.25)] },
  { code: 'SA_LABOUR', name: 'Saudi Arabia: Labour Law', region: 'Saudi Arabia', law: 'Saudi Labour Law (Royal Decree M/51)',
    description: 'Normal hours 8 a day and 48 a week; no more than 5 hours in a row without a break of at least half an hour; no more than 12 hours from start to finish; overtime at 1.5 times.',
    notes: 'Not covered: reduced hours in Ramadan (6 a day, 36 a week), and the weekly rest day rule.',
    rules: [daily(8), weekly(48), spread(12), meal(5, 30), days(6), overtime(8, 48, 1.5)] },

  // ---- Europe
  { code: 'GB_WTR', name: 'United Kingdom: Working Time Regulations', region: 'United Kingdom', law: 'Working Time Regulations 1998',
    description: 'Average week no more than 48 hours (checked per week here); 11 hours daily rest; a 20-minute break for shifts over 6 hours; a day off each week.',
    notes: 'Not covered: the opt-out from the 48-hour limit, night-worker limits, and the 24-hour weekly or 48-hour fortnightly rest. Overtime pay depends on the contract.',
    rules: [weekly(48, 'BLOCK'), rest(11), meal(6, 20), days(6)] },
  { code: 'DE_ARBZG', name: 'Germany: Working Hours Act', region: 'Germany', law: 'Arbeitszeitgesetz (ArbZG)',
    description: '8 hours a day, up to 10 if the average stays at 8 over six months; 48 hours a week; 11 hours daily rest; 30 minutes break after 6 hours.',
    notes: 'Not covered: 45 minutes break after 9 hours, the ban on Sunday and public-holiday work with its exceptions, and night-worker rules. Collective agreements often differ.',
    rules: [daily(8), daily(10, 'BLOCK'), weekly(48), rest(11), meal(6, 30), days(6)] },
  { code: 'FR_CODE_TRAVAIL', name: 'France: Labour Code', region: 'France', law: 'Code du travail (durée du travail)',
    description: 'Legal week of 35 hours, with a ceiling of 10 hours a day and 48 hours a week; 11 hours daily rest; a 20-minute break after 6 hours; overtime at 1.25 times for the first 8 hours.',
    notes: 'Not covered: the 44-hour average over 12 weeks, the 35-hour weekly rest, the higher overtime rate beyond 8 hours, and branch agreements.',
    rules: [daily(10, 'BLOCK'), weekly(35), weekly(48, 'BLOCK'), rest(11), meal(6, 20), days(6), overtime(24, 35, 1.25)] },
  { code: 'NL_ATW', name: 'Netherlands: Working Hours Act', region: 'Netherlands', law: 'Arbeidstijdenwet (ATW)',
    description: 'At most 12 hours a shift and 60 hours a week; 11 hours daily rest; a 30-minute break for shifts over 5.5 hours.',
    notes: 'Not covered: the 48-hour average over 16 weeks, the weekly rest of 36 hours, and night-work limits. Collective agreements often differ.',
    rules: [daily(12, 'BLOCK'), weekly(60, 'BLOCK'), rest(11), meal(5.5, 30), days(6)] },
  { code: 'ES_ET', name: 'Spain: Workers\' Statute', region: 'Spain', law: 'Estatuto de los Trabajadores',
    description: '40 hours a week on average; at most 9 hours a day; 12 hours between shifts; a 15-minute break for shifts over 6 hours.',
    notes: 'Not covered: the weekly rest of a day and a half, and overtime limits (80 hours a year). Collective agreements apply.',
    rules: [daily(9, 'BLOCK'), weekly(40), rest(12), meal(6, 15), days(6)] },
  { code: 'IT_DLGS_66', name: 'Italy: Working Time Decree', region: 'Italy', law: 'Decreto Legislativo 66/2003',
    description: '40 hours a week as the normal week, no more than 48 on average including overtime; 11 hours daily rest; a break for shifts over 6 hours (10 minutes unless the agreement says more).',
    notes: 'Not covered: the average over a reference period, the weekly rest of 24 hours, and night-work limits. National collective agreements set overtime pay.',
    rules: [weekly(40), weekly(48, 'BLOCK'), rest(11), meal(6, 10), days(6)] },
  { code: 'IE_OWTA', name: 'Ireland: Organisation of Working Time Act', region: 'Ireland', law: 'Organisation of Working Time Act 1997',
    description: 'Average week no more than 48 hours (checked per week here); 11 hours daily rest; a 30-minute break after 6 hours; a weekly rest of 24 hours.',
    notes: 'Not covered: the 15-minute break after 4.5 hours, the weekly rest of 24 hours, and Sunday premium rules. Employment regulation orders can differ.',
    rules: [weekly(48, 'BLOCK'), rest(11), meal(6, 30), days(6)] },
  { code: 'PL_KP', name: 'Poland: Labour Code', region: 'Poland', law: 'Kodeks pracy',
    description: '8 hours a day and 40 hours a week on average; 11 hours daily rest; a 15-minute break for shifts of 6 hours or more; overtime paid at 1.5 times (twice at night or on Sundays).',
    notes: 'Not covered: the 35-hour weekly rest, the 150 overtime hours a year, and the higher night and Sunday overtime rate.',
    rules: [daily(8), weekly(40), rest(11), meal(6, 15), days(6), overtime(8, 40, 1.5)] },

  // ---- North America
  { code: 'US_FLSA', name: 'United States: Fair Labor Standards Act (federal)', region: 'United States', law: 'Fair Labor Standards Act',
    description: 'No daily or weekly maximum for adults; overtime at 1.5 times after 40 hours in a week.',
    notes: 'Federal law has no rules on breaks or rest. States add their own (see the California pack, and copy it for other states). Exempt employees are not covered by overtime.',
    rules: [overtime(24, 40, 1.5)] },
  { code: 'US_CA', name: 'United States: California', region: 'United States', law: 'California Labor Code and IWC Wage Orders',
    description: 'Overtime at 1.5 times after 8 hours a day or 40 a week; a 30-minute meal period before the end of the 5th hour; a day of rest in seven.',
    notes: 'Not covered: double time after 12 hours a day, the second meal period after 10 hours, the 10-minute rest breaks, and meal-period penalty pay. Local ordinances and predictive-scheduling rules apply in some cities.',
    rules: [meal(5, 30), days(6), overtime(8, 40, 1.5)] },
  { code: 'CA_ON', name: 'Canada: Ontario', region: 'Canada', law: 'Employment Standards Act, 2000 (Ontario)',
    description: '8 hours a day and 44 hours a week before overtime at 1.5 times (up to 48 hours a week by agreement); 11 hours daily rest; a 30-minute eating period after 5 hours.',
    notes: 'Not covered: the 8 hours rest between shifts exceptions, the 24 hours off each week or 48 in two weeks, and public-holiday pay. Other provinces differ: copy this pack and adjust.',
    rules: [daily(8), weekly(44), weekly(48, 'BLOCK'), rest(11), meal(5, 30), days(6), overtime(24, 44, 1.5)] },
  { code: 'CA_BC', name: 'Canada: British Columbia', region: 'Canada', law: 'Employment Standards Act (British Columbia)',
    description: 'Overtime at 1.5 times after 8 hours a day or 40 a week (double after 12 hours); a 30-minute meal break after 5 hours.',
    notes: 'Not covered: double time after 12 hours a day, 8 hours between shifts, and 32 hours free each week. Other provinces differ.',
    rules: [meal(5, 30), days(6), overtime(8, 40, 1.5)] },
  { code: 'MX_LFT', name: 'Mexico: Federal Labour Law', region: 'Mexico', law: 'Ley Federal del Trabajo',
    description: 'Day shift 8 hours, 48 hours a week; overtime paid double for up to 9 hours a week and triple beyond; a rest day for every six days worked.',
    notes: 'Not covered: the shorter night (7 hours) and mixed (7.5 hours) shifts, the half-hour rest within a shift, and the weekly 24-hour rest premium.',
    rules: [daily(8), weekly(48), days(6), overtime(8, 48, 2)] },

  // ---- South America
  { code: 'BR_CLT', name: 'Brazil: Consolidation of Labour Laws', region: 'Brazil', law: 'Consolidação das Leis do Trabalho (CLT)',
    description: '8 hours a day and 44 a week; overtime up to 2 hours a day at 1.5 times; 11 hours between shifts; a one-hour break for shifts over 6 hours.',
    notes: 'Not covered: the 15-minute break for shifts of 4 to 6 hours, the weekly rest of 24 hours (preferably Sunday), and the night premium (22:00 to 05:00).',
    rules: [daily(8), daily(10, 'BLOCK'), weekly(44), rest(11), meal(6, 60), days(6), overtime(8, 44, 1.5)] },
  { code: 'AR_LCT', name: 'Argentina: Employment Contract Law', region: 'Argentina', law: 'Ley de Contrato de Trabajo 20.744 and Ley 11.544',
    description: '8 hours a day and 48 a week; 12 hours between shifts; overtime at 1.5 times (double on Sundays and holidays).',
    notes: 'Not covered: the weekly rest from Saturday 13:00 to Monday (35 hours), shorter night and unhealthy-work hours, and the overtime limits (30 hours a month).',
    rules: [daily(8), weekly(48), rest(12), days(6), overtime(8, 48, 1.5)] },

  // ---- Asia and Pacific
  { code: 'AU_NES', name: 'Australia: National Employment Standards', region: 'Australia', law: 'Fair Work Act 2009, National Employment Standards',
    description: '38 ordinary hours a week plus reasonable additional hours.',
    notes: 'The NES sets no rest or break rules. Modern awards and agreements add breaks (for example a meal break after 5 hours), rest between shifts (often 10 hours), overtime and penalty rates. Copy this pack and add your award\'s rules.',
    rules: [weekly(38), days(6)] },
  { code: 'NZ_ERA', name: 'New Zealand: Employment Relations Act', region: 'New Zealand', law: 'Employment Relations Act 2000, rest and meal breaks',
    description: 'A 30-minute meal break for shifts over 6 hours; paid 10-minute rest breaks.',
    notes: 'There is no legal maximum for hours. Not covered: the paid rest breaks (10 minutes for every 2 to 4 hours), and the holiday and night rules in awards and agreements.',
    rules: [meal(6, 30)] },
  { code: 'SG_EA', name: 'Singapore: Employment Act', region: 'Singapore', law: 'Employment Act 1968',
    description: '44 hours a week for ordinary work; no more than 12 hours a day; overtime at 1.5 times; a meal break of 45 minutes after 6 hours.',
    notes: 'Not covered: the cap of 72 overtime hours a month, the weekly rest day, and different rules for shift workers. The Act covers employees up to a pay level; others follow their contracts.',
    rules: [daily(12, 'BLOCK'), weekly(44), meal(6, 45), days(6), overtime(8, 44, 1.5)] },
  { code: 'MY_EA', name: 'Malaysia: Employment Act', region: 'Malaysia', law: 'Employment Act 1955',
    description: '8 hours a day and 45 a week; no more than 12 hours from start to finish; a 30-minute rest after 5 hours; overtime at 1.5 times; one rest day a week.',
    notes: 'Not covered: the cap of 104 overtime hours a month, and the higher rates on rest days and public holidays.',
    rules: [daily(8), weekly(45), spread(12), meal(5, 30), days(6), overtime(8, 45, 1.5)] },
  { code: 'ID_MANPOWER', name: 'Indonesia: Manpower Law', region: 'Indonesia', law: 'Law 13 of 2003 on Manpower, as amended by the Job Creation Law',
    description: '40 hours a week (8 a day on a five-day week, 7 on a six-day week); a rest of at least 30 minutes after 4 hours; overtime at 1.5 times then double.',
    notes: 'Not covered: the overtime cap of 4 hours a day and 18 a week, and the weekly rest days. The rules differ for night shifts and some sectors.',
    rules: [daily(8), weekly(40), meal(4, 30), days(6), overtime(8, 40, 1.5)] },
  { code: 'PH_LABOR', name: 'Philippines: Labor Code', region: 'Philippines', law: 'Labor Code of the Philippines',
    description: '8 hours a day; a meal period of at least 60 minutes; overtime pay of 25% more; a weekly rest of 24 hours after six days.',
    notes: 'Not covered: the 10% night-shift differential (22:00 to 06:00), premium pay on rest days and holidays, and compressed workweek agreements.',
    rules: [daily(8), meal(5, 60), days(6), overtime(8, 48, 1.25)] },
  { code: 'TH_LPA', name: 'Thailand: Labour Protection Act', region: 'Thailand', law: 'Labour Protection Act B.E. 2541 (1998)',
    description: '8 hours a day and 48 a week; at least an hour of rest after 5 hours of work; overtime at 1.5 times; a day off each week.',
    notes: 'Not covered: the cap of 36 overtime hours a week, and the higher rates on days off and holidays. Hazardous work has shorter limits.',
    rules: [daily(8), weekly(48), meal(5, 60), days(6), overtime(8, 48, 1.5)] },
  { code: 'VN_LABOUR_2019', name: 'Vietnam: Labour Code 2019', region: 'Vietnam', law: 'Labour Code 45/2019/QH14',
    description: '8 hours a day and 48 a week; a break of at least 30 minutes in shifts of 6 hours or more (45 minutes at night); overtime at 1.5 times.',
    notes: 'Not covered: the overtime cap (40 hours a month, 300 a year in some sectors), the daily rest, and the higher rates at night and on days off.',
    rules: [daily(8), weekly(48), meal(6, 30), days(6), overtime(8, 48, 1.5)] },
  { code: 'JP_LSA', name: 'Japan: Labor Standards Act', region: 'Japan', law: 'Labor Standards Act (労働基準法)',
    description: '8 hours a day and 40 a week; a 45-minute break for shifts over 6 hours (an hour over 8); overtime at 1.25 times; at least one day off a week.',
    notes: 'Not covered: the one-hour break for shifts over 8 hours, the overtime limits agreed under Article 36 (45 hours a month), and the 1.5 times rate beyond 60 hours a month.',
    rules: [daily(8), weekly(40), meal(6, 45), days(6), overtime(8, 40, 1.25)] },
  { code: 'KR_LSA', name: 'South Korea: Labor Standards Act', region: 'South Korea', law: 'Labor Standards Act (근로기준법)',
    description: '40 hours a week plus at most 12 hours of overtime (52 in all); a 30-minute break for 4 hours of work; overtime at 1.5 times.',
    notes: 'Not covered: the one-hour break for 8 hours, the weekly paid rest day, and the night premium (22:00 to 06:00).',
    rules: [weekly(40), weekly(52, 'BLOCK'), meal(4, 30), days(6), overtime(8, 40, 1.5)] },
  { code: 'CN_LABOUR', name: 'China: Labour Law', region: 'China', law: 'Labour Law of the PRC and State Council regulations on working hours',
    description: '8 hours a day and 40 a week as the standard; overtime of at most 3 hours a day paid at 1.5 times; a rest day each week.',
    notes: 'Not covered: the overtime cap of 36 hours a month, double pay on rest days and triple pay on public holidays, and comprehensive or flexible working-hours approvals.',
    rules: [daily(8), daily(11, 'BLOCK'), weekly(40), days(6), overtime(8, 40, 1.5)] },
  { code: 'TW_LSA', name: 'Taiwan: Labor Standards Act', region: 'Taiwan', law: 'Labor Standards Act (勞動基準法)',
    description: '8 hours a day and 40 a week; a break of at least 30 minutes after 4 hours; 11 hours between shifts; overtime of at most 4 hours a day.',
    notes: 'Not covered: the overtime cap (46 hours a month), the regular day off and rest day each week, and the 1.34 and 1.67 overtime rates.',
    rules: [daily(8), daily(12, 'BLOCK'), weekly(40), rest(11), meal(4, 30), days(6), overtime(8, 40, 1.34)] },
];
