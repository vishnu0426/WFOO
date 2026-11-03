import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvalLine as portal, waitingLabel as portalLabel } from '../../../employee-portal/src/approval.ts';
import { approvalLine as mobile, waitingLabel as mobileLabel } from '../../../mobile/src/lib/approval.ts';

// the portal and the mobile app carry the same file; running every case through both keeps them from drifting apart
for (const [name, line, label] of [['employee portal', portal, portalLabel], ['mobile app', mobile, mobileLabel]] as const) {
  describe(`who has a request, in words (${name})`, () => {
    it('says a request is with the team supervisor, by name', () => {
      assert.equal(line({ status: 'REQUESTED', waitingFor: { level: 'SUPERVISOR', names: ['Priya Nair'] } }), 'Waiting for your supervisor, Priya Nair.');
      assert.equal(line({ status: 'PENDING_APPROVAL', waitingFor: { level: 'SUPERVISOR', names: ['Priya Nair', 'Dev Rao'] } }), 'Waiting for your supervisor, Priya Nair or Dev Rao.');
      assert.equal(label({ level: 'SUPERVISOR', names: [] }), 'Waiting for your supervisor');
    });
    it('says a request is with a manager when the team has no supervisor, or nobody is known', () => {
      assert.equal(line({ status: 'REQUESTED', waitingFor: { level: 'MANAGER', names: [] } }), 'Waiting for a manager.');
      assert.equal(label({ level: 'MANAGER', names: [] }), 'Waiting for a manager');
      assert.equal(label(null), 'Waiting for a manager');
      assert.equal(line({ status: 'REQUESTED', waitingFor: null }), null, 'nothing is said when the server did not say');
    });
    it('says when it has waited too long and the managers were told', () => {
      assert.match(line({ status: 'REQUESTED', escalatedAt: '2026-11-02T10:00:00Z', waitingFor: { level: 'SUPERVISOR', names: ['Priya Nair'] } })!, /managers have been told/);
    });
    it('says who decided, at which level', () => {
      assert.equal(line({ status: 'APPROVED', decidedBy: 'Priya Nair', decidedLevel: 'SUPERVISOR' }), 'Approved by your supervisor, Priya Nair.');
      assert.equal(line({ status: 'REJECTED', decidedBy: 'Sam Lee', decidedLevel: 'MANAGER' }), 'Declined by a manager, Sam Lee.');
      assert.equal(line({ status: 'APPROVED', decidedBy: 'Sam Lee', decidedLevel: null }), 'Approved by Sam Lee.');
    });
    it('says nothing for what the rules decided on their own, or for requests that were cancelled', () => {
      assert.equal(line({ status: 'APPROVED', decidedBy: 'Automatic approval', autoDecided: true }), null);
      assert.equal(line({ status: 'APPROVED', decidedBy: 'Rules', autoApproved: true, decidedLevel: null }), null);
      assert.equal(line({ status: 'CANCELLED', decidedBy: 'Sam Lee' }), null);
    });
  });
}
