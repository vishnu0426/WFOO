/** The plain-words limits shown on a compliance pack's card.  backend/gateway/node_modules/.bin/tsx --test src/components/configuration/CompliancePanel.test.ts */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headline } from './complianceText.ts';

const rule = (type: string, params: Record<string, unknown>, severity: 'BLOCK' | 'WARN' = 'BLOCK') => ({ id: type, type, severity, params });

describe('a pack card\'s headline limits', () => {
  it('says the limits in plain words, what blocks publishing first, at most three', () => {
    const h = headline({ rules: [rule('MAX_DAILY_HOURS', { hours: 8 }, 'WARN'), rule('MAX_WEEKLY_HOURS', { hours: 48 }), rule('MIN_DAILY_REST_HOURS', { hours: 11 }), rule('MAX_CONSECUTIVE_DAYS', { days: 6 }), rule('NIGHT_WORK', { requiresConsent: true })] });
    assert.deepEqual(h.shown, ['48 h a week', '11 h rest', '6 days in a row']);
    assert.equal(h.more, 2);
    assert.equal(h.warnOnly, false);
  });
  it('says when a pack only warns', () => {
    const h = headline({ rules: [rule('MAX_WEEKLY_HOURS', { hours: 48 }, 'WARN'), rule('MIN_NOTICE_DAYS', { days: 14 }, 'WARN')] });
    assert.equal(h.warnOnly, true);
    assert.deepEqual(h.shown, ['48 h a week', '14 days\' notice']);
  });
  it('has nothing to say for a pack with no rules, and skips rules it has no words for', () => {
    assert.deepEqual(headline({ rules: [] }), { shown: [], more: 0, warnOnly: false });
    assert.deepEqual(headline({ rules: [rule('OVERTIME_PREMIUM', { multiplier: 2 }, 'WARN')] }).shown, []);
  });
  it('knows the weekend rules', () => {
    assert.deepEqual(headline({ rules: [rule('MIN_DAYS_OFF_TOGETHER', { days: 2 }), rule('MIN_WEEKENDS_OFF_MONTH', { weekends: 2 })] }).shown, ['2 days off together', '2 weekends off a month']);
  });
});

describe('where a pack applies', () => {
  it('says the whole organisation, or counts what it is set for', async () => {
    const { scopeText } = await import('./complianceText.ts');
    assert.equal(scopeText([{ scopeType: 'TENANT', scopeName: 'Whole organisation' }]), 'Whole organisation');
    assert.equal(scopeText([{ scopeType: 'TENANT', scopeName: 'Whole organisation' }, { scopeType: 'TEAM', scopeName: 'A' }]), 'Whole organisation + 1 more');
    assert.equal(scopeText([{ scopeType: 'GROUP', scopeName: 'A' }, { scopeType: 'GROUP', scopeName: 'B' }, { scopeType: 'TEAM', scopeName: 'C' }]), '2 groups, 1 team');
  });
});

describe('a rule as a sentence', () => {
  it('reads every kind of rule in full words', async () => {
    const { ruleLine } = await import('./complianceText.ts');
    assert.equal(ruleLine(rule('MAX_WEEKLY_HOURS', { hours: 48 })), 'At most 48 paid hours in a pay week');
    assert.equal(ruleLine(rule('MEAL_BREAK', { afterHours: 6, minutes: 20 })), 'A shift longer than 6 hours has a meal or rest interval of at least 20 minutes');
    assert.match(ruleLine(rule('NIGHT_WORK', { from: '19:00', to: '06:00', requiresConsent: true })), /needs the person's recorded consent/);
    assert.match(ruleLine(rule('OVERTIME_PREMIUM', { afterDailyHours: 8, afterWeeklyHours: 48, multiplier: 2 })), /paid at 2 times/);
    assert.equal(ruleLine(rule('MIN_WEEKENDS_OFF_MONTH', { weekends: 2 })), 'At least 2 full weekends off in every month');
  });
});
