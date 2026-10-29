import React, { useState } from 'react';
import {
  ShieldCheck,
  Users,
  UserCheck,
  Building2,
  Calendar,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Plus,
  ArrowUpRight,
  Sparkles,
  Info,
  RefreshCw,
} from 'lucide-react';
import { api, LicenseUsageReport, LicenseCapacityRequest } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input } from '../forecasting/ui';

const MODULE_META: Record<string, { label: string; desc: string; icon: string }> = {
  FORECASTING: { label: 'Forecasting Engine', desc: 'Multi-model AI forecasting & what-if scenario planning', icon: '📈' },
  SCHEDULING: { label: 'Automated Scheduling', desc: 'Rule-based CP-SAT schedule generator & shift builder', icon: '📅' },
  INTRADAY: { label: 'Intraday & RTA', desc: 'Live intervals, break optimization & real-time monitoring', icon: '⚡' },
  ADHERENCE: { label: 'Real-Time Adherence', desc: 'Live event tracking, state mapping & deviation alerts', icon: '🎯' },
  TIME_OFF: { label: 'Time Off Management', desc: 'Allowance tracking, blackout rules & automated approvals', icon: '🏖️' },
  SHIFT_BIDDING: { label: 'Shift Bidding & Swaps', desc: 'Roster bidding rounds, giveaway board & shift trading', icon: '🔄' },
  EMPLOYEE_SELF_SERVICE: { label: 'Employee Self-Service', desc: 'Mobile/web self-service portal for agents', icon: '📱' },
  REPORTING: { label: 'Reporting & Analytics', desc: 'Operational dashboards, shrinkage & payroll exports', icon: '📊' },
  AI_COPILOT: { label: 'AI WFM Copilot', desc: 'Generative AI schedule repair & intraday recommendations', icon: '✨' },
};

export const LicenseSubscriptionView: React.FC = () => {
  const { session } = useForecast();
  const [tick, setTick] = useState(0);
  const licenseReq = useApi<LicenseUsageReport>('/license', [tick]);
  const requestsReq = useApi<LicenseCapacityRequest[]>('/license/requests', [tick]);

  const [modalOpen, setModalOpen] = useState(false);
  const [resourceType, setResourceType] = useState<'EMPLOYEES' | 'USERS' | 'SITES'>('EMPLOYEES');
  const [additionalNeeded, setAdditionalNeeded] = useState(25);
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  if (licenseReq.loading && !licenseReq.data) {
    return <Busy text="Loading license & subscription details…" />;
  }

  const report = licenseReq.data;
  if (!report) {
    return (
      <div className="p-8">
        <Banner kind="warn">No active license found for this organization.</Banner>
      </div>
    );
  }

  const { license, modules, capacity, lifecycle } = report;

  const currentCap =
    resourceType === 'EMPLOYEES'
      ? capacity.employees.max
      : resourceType === 'USERS'
      ? capacity.users.max
      : license.maxSites;

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      await api('/license/requests', {
        method: 'POST',
        body: {
          resourceType,
          currentCapacity: currentCap,
          requestedCapacity: currentCap + Number(additionalNeeded),
          additionalNeeded: Number(additionalNeeded),
          justification: justification.trim(),
        },
      });
      setModalOpen(false);
      setJustification('');
      setNotice('Capacity request submitted successfully. Your platform administrator has been notified.');
      setTick((t) => t + 1);
    } catch (err: any) {
      setError(err.message || 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  const getCapacityColor = (percent: number) => {
    if (percent >= 100) return 'bg-[#DC2626]';
    if (percent >= 85) return 'bg-[#F59E0B]';
    return 'bg-[#171717]';
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-white p-6 space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[20px] font-semibold text-[#171717]">License & Subscription</h1>
            <span
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                lifecycle.status === 'ACTIVE'
                  ? 'bg-[#DCFCE7] text-[#15803D]'
                  : lifecycle.status === 'GRACE_PERIOD'
                  ? 'bg-[#FEF3C7] text-[#B45309]'
                  : 'bg-[#FEE2E2] text-[#B91C1C]'
              }`}
            >
              {lifecycle.status}
            </span>
          </div>
          <p className="text-[13px] text-[#737373] mt-0.5">
            Commercial plan entitlements, capacity limits, and modular feature access for {session.tenant.name}.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Btn onClick={() => setTick((t) => t + 1)}>
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Btn>
          <Btn variant="primary" onClick={() => setModalOpen(true)}>
            <ArrowUpRight className="w-3.5 h-3.5" />
            Request Capacity Increase
          </Btn>
        </div>
      </div>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      {/* Grace period or lifecycle warnings */}
      {lifecycle.message && (
        <div
          className={`p-4 rounded-lg border flex items-start gap-3 ${
            lifecycle.isReadOnly
              ? 'bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]'
              : lifecycle.isRestricted
              ? 'bg-[#FFFBEB] border-[#FCD34D] text-[#92400E]'
              : 'bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]'
          }`}
        >
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-[13px]">Subscription Status Notice</div>
            <div className="text-[12px] mt-0.5">{lifecycle.message}</div>
          </div>
        </div>
      )}

      {/* License Contract & Summary Card */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg">
          <div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Plan & Edition</div>
          <div className="text-[18px] font-bold text-[#171717] mt-1">{license.planTier}</div>
          <div className="text-[12px] text-[#737373]">{license.edition}</div>
        </div>

        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg">
          <div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">License Key</div>
          <div className="text-[14px] font-mono font-bold text-[#171717] mt-1 truncate" title={license.licenseKey}>
            {license.licenseKey}
          </div>
          <div className="text-[12px] text-[#737373]">Issued by: {license.issuedBy}</div>
        </div>

        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg">
          <div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Valid Until</div>
          <div className="text-[16px] font-semibold text-[#171717] mt-1">
            {new Date(license.endDate).toLocaleDateString()}
          </div>
          <div className="text-[12px] text-[#737373]">
            {lifecycle.daysRemaining > 0
              ? `${lifecycle.daysRemaining} days remaining`
              : `Expired ${Math.abs(lifecycle.daysRemaining)} days ago`}
          </div>
        </div>

        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg">
          <div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Grace Period</div>
          <div className="text-[16px] font-semibold text-[#171717] mt-1">
            {license.gracePeriodDays} Days Policy
          </div>
          <div className="text-[12px] text-[#737373]">
            {lifecycle.inGracePeriod ? `${license.gracePeriodDays - lifecycle.daysInGrace} days left` : 'Standard coverage'}
          </div>
        </div>
      </div>

      {/* Capacity Utilization Progress Bars */}
      <div>
        <h2 className="text-[16px] font-semibold text-[#171717] mb-3">Capacity Governance & Quotas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Active Employees */}
          <div className="border border-[#E5E5E0] p-5 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-[#525252]" />
                <span className="font-semibold text-[14px]">Active WFM Employees</span>
              </div>
              <span className="text-[12px] font-mono font-medium">
                {capacity.employees.current} / {capacity.employees.max} ({capacity.employees.percentage}%)
              </span>
            </div>

            <div className="w-full bg-[#E5E5E0] h-3 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getCapacityColor(capacity.employees.percentage)}`}
                style={{ width: `${Math.min(100, capacity.employees.percentage)}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[12px] text-[#737373]">
              <span>
                {capacity.employees.remaining > 0
                  ? `${capacity.employees.remaining} available seats remaining`
                  : 'Capacity full (0 seats available)'}
              </span>
              <button
                onClick={() => {
                  setResourceType('EMPLOYEES');
                  setModalOpen(true);
                }}
                className="text-[#171717] font-medium hover:underline inline-flex items-center gap-1"
              >
                Increase limit <ArrowUpRight className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Named Users */}
          <div className="border border-[#E5E5E0] p-5 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-[#525252]" />
                <span className="font-semibold text-[14px]">Named User Accounts</span>
              </div>
              <span className="text-[12px] font-mono font-medium">
                {capacity.users.current} / {capacity.users.max} ({capacity.users.percentage}%)
              </span>
            </div>

            <div className="w-full bg-[#E5E5E0] h-3 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getCapacityColor(capacity.users.percentage)}`}
                style={{ width: `${Math.min(100, capacity.users.percentage)}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[12px] text-[#737373]">
              <span>{capacity.users.remaining} login seats remaining</span>
              <button
                onClick={() => {
                  setResourceType('USERS');
                  setModalOpen(true);
                }}
                className="text-[#171717] font-medium hover:underline inline-flex items-center gap-1"
              >
                Increase limit <ArrowUpRight className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Supervisors */}
          <div className="border border-[#E5E5E0] p-5 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#525252]" />
                <span className="font-semibold text-[14px]">Supervisor / RTA Seats</span>
              </div>
              <span className="text-[12px] font-mono font-medium">
                {capacity.supervisors.current} / {capacity.supervisors.max}
              </span>
            </div>
            <div className="w-full bg-[#E5E5E0] h-2 rounded-full overflow-hidden">
              <div
                className={`h-full ${getCapacityColor(capacity.supervisors.percentage)}`}
                style={{ width: `${Math.min(100, capacity.supervisors.percentage)}%` }}
              />
            </div>
            <div className="text-[12px] text-[#737373]">
              {capacity.supervisors.remaining} supervisor seats remaining
            </div>
          </div>

          {/* Workspaces & Sites */}
          <div className="border border-[#E5E5E0] p-5 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-[#525252]" />
                <span className="font-semibold text-[14px]">Workspaces & Sites</span>
              </div>
              <span className="text-[12px] font-mono font-medium">
                {capacity.workspaces.current} / {capacity.workspaces.max} Workspaces
              </span>
            </div>
            <div className="w-full bg-[#E5E5E0] h-2 rounded-full overflow-hidden">
              <div
                className={`h-full ${getCapacityColor(capacity.workspaces.percentage)}`}
                style={{ width: `${Math.min(100, capacity.workspaces.percentage)}%` }}
              />
            </div>
            <div className="text-[12px] text-[#737373]">
              Maximum {license.maxSites} sites allowed under this license
            </div>
          </div>
        </div>
      </div>

      {/* Modular Feature Entitlements */}
      <div>
        <h2 className="text-[16px] font-semibold text-[#171717] mb-3">Modular Feature Entitlements</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(MODULE_META).map(([code, meta]) => {
            const mod = modules.find((m) => m.moduleCode === code);
            const isEnabled = mod ? mod.enabled : false;

            return (
              <div
                key={code}
                className={`p-4 rounded-lg border transition-all ${
                  isEnabled ? 'bg-white border-[#E5E5E0]' : 'bg-[#FAFAF8] border-[#E5E5E0] opacity-60'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[20px]">{meta.icon}</span>
                    <span className="font-semibold text-[13px] text-[#171717]">{meta.label}</span>
                  </div>
                  {isEnabled ? (
                    <CheckCircle2 className="w-4 h-4 text-[#15803D]" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[#A3A3A3]" />
                  )}
                </div>
                <p className="text-[12px] text-[#737373] mt-1.5 leading-snug">{meta.desc}</p>
                <div className="mt-2.5">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide ${
                      isEnabled ? 'bg-[#DCFCE7] text-[#15803D]' : 'bg-[#F5F5F5] text-[#737373]'
                    }`}
                  >
                    {isEnabled ? 'LICENSED' : 'NOT ENTITLED'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Past Capacity Requests History */}
      {requestsReq.data && requestsReq.data.length > 0 && (
        <div>
          <h2 className="text-[16px] font-semibold text-[#171717] mb-3">Capacity Request History</h2>
          <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">Date</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Requested Delta</th>
                  <th className="py-2.5 px-4">Justification</th>
                  <th className="py-2.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E5E0]">
                {requestsReq.data.map((req) => (
                  <tr key={req.id}>
                    <td className="py-2.5 px-4 text-[#737373]">
                      {new Date(req.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 px-4 font-medium">{req.resourceType}</td>
                    <td className="py-2.5 px-4 font-mono font-medium">+{req.additionalNeeded} seats</td>
                    <td className="py-2.5 px-4 text-[#737373] max-w-xs truncate" title={req.justification}>
                      {req.justification || '—'}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          req.status === 'APPROVED'
                            ? 'bg-[#DCFCE7] text-[#15803D]'
                            : req.status === 'REJECTED'
                            ? 'bg-[#FEE2E2] text-[#B91C1C]'
                            : 'bg-[#FEF3C7] text-[#B45309]'
                        }`}
                      >
                        {req.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Request Capacity Increase Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl border border-[#E5E5E0] w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-[#E5E5E0] flex items-center justify-between">
              <h3 className="font-semibold text-[15px] text-[#171717]">Request Capacity Increase</h3>
              <button
                onClick={() => setModalOpen(false)}
                className="text-[#737373] hover:text-[#171717] text-[18px]"
              >
                ✕
              </button>
            </div>

            <form onSubmit={submitRequest} className="p-5 space-y-4">
              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                  Resource Type
                </label>
                <select
                  value={resourceType}
                  onChange={(e) => setResourceType(e.target.value as any)}
                  className="w-full border border-[#E5E5E0] rounded px-3 py-2 text-[13px] bg-white focus:outline-none focus:border-[#171717]"
                >
                  <option value="EMPLOYEES">Active Employees (Agents)</option>
                  <option value="USERS">Named User Logins</option>
                  <option value="SITES">Sites & Physical Locations</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-[#737373] mb-1">Current Capacity</label>
                  <div className="border border-[#E5E5E0] bg-[#FAFAF8] rounded px-3 py-2 text-[13px] font-mono font-medium">
                    {currentCap}
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                    Additional Seats
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    value={additionalNeeded}
                    onChange={(e) => setAdditionalNeeded(Number(e.target.value))}
                    required
                    className="w-full border border-[#E5E5E0] rounded px-3 py-2 text-[13px] font-mono focus:outline-none focus:border-[#171717]"
                  />
                </div>
              </div>

              <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] text-[12px] flex items-center justify-between">
                <span className="text-[#737373]">New Target Capacity:</span>
                <span className="font-bold text-[14px] text-[#171717] font-mono">
                  {currentCap + Number(additionalNeeded)} seats
                </span>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                  Business Justification
                </label>
                <textarea
                  rows={3}
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  placeholder="e.g. Onboarding new queue for peak holiday season"
                  className="w-full border border-[#E5E5E0] rounded p-2 text-[13px] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#E5E5E0]">
                <Btn onClick={() => setModalOpen(false)}>Cancel</Btn>
                <Btn variant="primary" type="submit" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit Request'}
                </Btn>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
