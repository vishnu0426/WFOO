// The 50,000-person organisation: 13 WFM groups, each a different scheduling/forecasting situation.
// demand: people needed at the busiest hour as a share of the group (0.5 = about half the crew, like scripts/bench-scale.mjs).
export const WEEK_FROM = '2026-11-02';            // Monday after the test day (Sat 31 Oct 2026)
const OFFICE = [0, 1, 2, 3, 4], ALL = [0, 1, 2, 3, 4, 5, 6];

export const SCENARIOS = [
  { key: 'S01', name: 'Voice office hours', size: 6000, tz: 'Asia/Kolkata', model: 'auto', demand: 0.5, shape: 'office', channel: 'VOICE',
    templates: [['Early', OFFICE, '07:00', '09:00'], ['Mid', OFFICE, '09:30', '11:00']], what: 'Mon–Fri 08:00–20:00 demand, full-time 40 h, weekday-only templates' },
  { key: 'S02', name: 'Voice 24x7 with nights', size: 6000, tz: 'Asia/Kolkata', model: 'sarima', demand: 0.45, shape: 'flat24', channel: 'VOICE', nights: true,
    templates: [['Day', ALL, '06:00', '10:00'], ['Swing', ALL, '13:00', '15:00'], ['Night', ALL, '21:00', '23:00']], what: 'Round-the-clock demand, overnight shifts for people with night consent, SARIMA forecast' },
  { key: 'S03', name: 'Chat part-time mix', size: 5000, tz: 'Asia/Kolkata', model: 'ets', demand: 0.4, shape: 'standard', channel: 'CHAT', partTime: 0.5,
    templates: [['Flex', ALL, '07:00', '14:00', { minDurationHours: 4, durationHours: 8.5, lengthStepMinutes: 60 }]], what: '50% part-timers (20 h, 4 days), variable-length 4–8.5 h shifts, chat concurrency, ETS forecast' },
  { key: 'S04', name: 'Email back office', size: 3000, tz: 'Asia/Kolkata', model: 'croston', demand: 0.35, shape: 'office', channel: 'EMAIL', lowVolume: true,
    templates: [['Office', OFFICE, '08:00', '10:00']], what: 'Low, intermittent email volume (Croston), Mon–Fri' },
  { key: 'S05', name: 'Multi-skill EN/ES', size: 5000, tz: 'Asia/Kolkata', model: 'wavg', demand: 0.5, shape: 'standard', channel: 'VOICE', skills: true,
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: 'Two queues needing different skills (60% EN, 20% ES, 20% both), weighted-average forecast' },
  { key: 'S06', name: 'Time off and availability', size: 4000, tz: 'Asia/Kolkata', model: 'gbm', demand: 0.5, shape: 'standard', channel: 'VOICE', timeOff: 0.1, avail: 0.1,
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: '10% on approved leave in the week, 10% with unavailable windows, gradient-boosting forecast' },
  { key: 'S07', name: 'Rotation 4-on-4-off', size: 2000, tz: 'Asia/Kolkata', model: 'snaive', demand: 0.45, shape: 'flat24', channel: 'VOICE', rotation: true,
    templates: [['Rota day', ALL, '07:00', '07:00', { durationHours: 12, mealMinutes: 60 }]], what: 'Two-crew 4-on-4-off 12 h rotation materialized into shifts, seasonal-naive forecast' },
  { key: 'S08', name: 'Weekend retail peaks', size: 4000, tz: 'Asia/Kolkata', model: 'combo', demand: 0.5, shape: 'weekend', channel: 'VOICE', noWeekend: 0.3, historyGaps: true,
    templates: [['Day', ALL, '08:00', '10:00'], ['Late', ALL, '12:00', '14:00']], what: 'Weekend demand 1.6× weekdays, 30% may not work weekends, 5 missing days in history, combo forecast' },
  { key: 'S09', name: 'London site (Europe/London)', size: 4000, tz: 'Europe/London', model: 'arima', demand: 0.5, shape: 'standard', channel: 'VOICE', outliers: true, site: true,
    templates: [['Day', ALL, '07:00', '09:00'], ['Late', ALL, '11:00', '13:00']], what: 'Another site and time zone (UK, week after the clocks changed), outlier days in history, ARIMA' },
  { key: 'S10', name: 'Long plan 13 weeks', size: 2000, tz: 'Asia/Kolkata', model: 'auto', demand: 0.5, shape: 'standard', channel: 'VOICE', longPlan: true,
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: '13-week background plan (4 solved weeks, rest repeated) on short + long-term (365-day) forecasts' },
  { key: 'S11', name: 'Overstaffed (VTO)', size: 3000, tz: 'Asia/Kolkata', model: 'auto', demand: 0.2, shape: 'standard', channel: 'VOICE', offers: 'VTO',
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: 'Demand far below the crew: surplus, voluntary-time-off suggestions' },
  { key: 'S12', name: 'Understaffed (overtime)', size: 3000, tz: 'Asia/Kolkata', model: 'auto', demand: 1.1, shape: 'standard', channel: 'VOICE', offers: 'OVERTIME', adjust: 20, event: true,
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: 'Demand above the crew, +20% forecast adjustment and a special event: gaps, overtime suggestions' },
  { key: 'S13', name: 'Candidate-limit boundary', size: 3000, tz: 'Asia/Kolkata', model: 'auto', demand: 0.5, shape: 'standard', channel: 'VOICE', boundary: true,
    templates: [['Day', ALL, '06:00', '08:00'], ['Late', ALL, '11:00', '13:00']], what: 'First a template with every 15-minute start and length (millions of options) to check the refusal, then normal templates' },
];
export const TOTAL = SCENARIOS.reduce((n, s) => n + s.size, 0);
