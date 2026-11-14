import React, { useState } from 'react';
import { Waiting } from '../common/loading';
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
  X,
  Check,
  TrendingUp,
  CalendarDays,
  Activity,
  Target,
  CalendarCheck,
  Repeat,
  Smartphone,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { api, LicenseUsageReport, LicenseCapacityRequest } from '../../services/api';
import { PlanChangeModal } from './PlanChangeModal';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input } from '../forecasting/ui';

const MODULE_META: Record<string, { label: string; desc: string; icon: LucideIcon }> = {
  FORECASTING: { label: 'Forecasting', desc: 'Forecasts from your history, with what-if scenarios', icon: TrendingUp },
  SCHEDULING: { label: 'Scheduling', desc: 'Builds schedules from the forecast and your rules', icon: CalendarDays },
  INTRADAY: { label: 'Intraday & RTA', desc: 'Live coverage, break optimisation and real-time monitoring', icon: Activity },
  ADHERENCE: { label: 'Real-time adherence', desc: 'Live agent status, state mapping and alerts', icon: Target },
  TIME_OFF: { label: 'Time off', desc: 'Allowances, blackout rules and approvals', icon: CalendarCheck },
  SHIFT_BIDDING: { label: 'Shift bidding and swaps', desc: 'Bidding rounds, shift giveaways and trades', icon: Repeat },
  EMPLOYEE_SELF_SERVICE: { label: 'Employee self-service', desc: 'Mobile and web app for your people', icon: Smartphone },
  REPORTING: { label: 'Reporting', desc: 'Dashboards, shrinkage and payroll exports', icon: BarChart3 },
  AI_COPILOT: { label: 'AI assistant', desc: 'Suggests schedule repairs and intraday actions', icon: Sparkles },
};
const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const num = (n: number) => n.toLocaleString();
const planName = (tier: string) => (tier === 'CUSTOM' ? 'Custom plan' : tier.charAt(0) + tier.slice(1).toLowerCase().replace(/_/g, ' '));

export const LicenseSubscriptionView: React.FC = () => {
  const { session } = useForecast();
  const [tick, setTick] = useState(0);
  const licenseReq = useApi<LicenseUsageReport>('/license', [tick]);
  const requestsReq = useApi<LicenseCapacityRequest[]>('/license/requests', [tick]);

  const [modalOpen, setModalOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [resourceType, setResourceType] = useState<'EMPLOYEES' | 'USERS' | 'SITES' | 'WORKSPACES' | 'MODULES'>('EMPLOYEES');
  const [wantedModules, setWantedModules] = useState<string[]>([]);
  const [additionalNeeded, setAdditionalNeeded] = useState(25);
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  if (licenseReq.loading && !licenseReq.data) {
    return <div className="space-y-4"><Waiting what="license and subscription details" shape="cards" reload={licenseReq.reload} /></div>;
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
      : resourceType === 'WORKSPACES'
      ? license.maxWorkspaces
      : license.maxSites;
  const UNIT: Record<string, string> = { EMPLOYEES: 'seats', USERS: 'logins', SITES: 'sites', WORKSPACES: 'workspaces' };
  const notEntitled = Object.keys(MODULE_META).filter((code) => !(modules.find((m) => m.moduleCode === code)?.enabled));
  const pendingKinds = new Set((requestsReq.data ?? []).filter((r) => r.status === 'PENDING').map((r) => r.resourceType));
  const pendingModules = new Set((requestsReq.data ?? []).filter((r) => r.status === 'PENDING' && r.resourceType === 'MODULES').flatMap((r) => r.requestedModules ?? []));
  const openRequest = (kind: typeof resourceType, mods: string[] = []) => { setResourceType(kind); setWantedModules(mods); setAdditionalNeeded(kind === 'EMPLOYEES' ? 25 : 1); setModalOpen(true); };

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      await api('/license/requests', {
        method: 'POST',
        body: resourceType === 'MODULES'
          ? { resourceType, modules: wantedModules, justification: justification.trim() }
          : { resourceType, additionalNeeded: Number(additionalNeeded), justification: justification.trim() },
      });
      setModalOpen(false);
      setJustification('');
      setNotice('Your request was sent for approval. You will see the decision under Request History.');
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

  const status = lifecycle.status === 'ACTIVE' ? { label: lifecycle.daysRemaining <= 30 ? 'Expiring soon' : 'Active', cls: lifecycle.daysRemaining <= 30 ? 'bg-[#FEF3C7] text-[#B45309]' : 'bg-[#DCFCE7] text-[#15803D]' }
    : lifecycle.status === 'GRACE_PERIOD' ? { label: 'In grace period', cls: 'bg-[#FEF3C7] text-[#B45309]' } : { label: 'Expired', cls: 'bg-[#FEE2E2] text-[#B91C1C]' };
  const anyPending = (requestsReq.data ?? []).some((r) => r.status === 'PENDING');

  /** One limit: what is used, how much is left, and what happens at the limit. */
  const Limit: React.FC<{ icon: LucideIcon; title: string; m: { current: number; max: number; remaining: number; percentage: number }; unit: string; kind?: 'EMPLOYEES' | 'USERS' | 'SITES' | 'WORKSPACES'; atLimit: string }> = ({ icon: Icon, title, m, unit, kind, atLimit }) => {
    const pct = Math.min(100, Math.round(m.percentage));
    const level = m.percentage >= 100 ? 'full' : m.percentage >= 80 ? 'near' : 'ok';
    return (
      <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-3 bg-white">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0"><Icon className="w-4 h-4 text-[#525252] shrink-0" /><span className="font-semibold text-[13px] text-[#171717] truncate">{title}</span></div>
          {level !== 'ok' && <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${level === 'full' ? 'bg-[#FEE2E2] text-[#B91C1C]' : 'bg-[#FEF3C7] text-[#B45309]'}`}>{level === 'full' ? 'Limit reached' : 'Nearly full'}</span>}
        </div>
        <div>
          <div className="flex items-baseline gap-1.5"><span className="text-[22px] font-semibold tabular-nums text-[#171717]">{num(m.current)}</span><span className="text-[12px] text-[#737373]">of {num(m.max)} {unit}</span></div>
          <div className="mt-2 w-full bg-[#EDEDE8] h-2 rounded-full overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${title} used`}>
            <div className={`h-full transition-all duration-500 ${level === 'full' ? 'bg-[#DC2626]' : level === 'near' ? 'bg-[#F59E0B]' : 'bg-[#171717]'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <p className={`text-[12px] ${level === 'ok' ? 'text-[#737373]' : level === 'near' ? 'text-[#92400E]' : 'text-[#991B1B]'}`}>{m.remaining > 0 ? `You can add ${num(m.remaining)} more.${level === 'near' ? ' Consider asking for more soon.' : ''}` : atLimit}</p>
        {kind && pendingKinds.has(kind) && <p className="text-[11px] text-[#B45309]">A request for more is waiting for a decision.</p>}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-white p-6 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-[20px] font-semibold text-[#171717]">Licence and subscription</h1>
            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${status.cls}`}>{status.label}</span>
          </div>
          <p className="text-[13px] text-[#737373]">What your plan includes for {session.tenant.name}, how much of it you are using, and how to ask for more.</p>
        </div>
        <div className="flex items-center gap-2">
          <Btn onClick={() => setTick((t) => t + 1)}><RefreshCw className="w-3.5 h-3.5" />Refresh</Btn>
          <Btn onClick={() => setPlanOpen(true)}>Change plan</Btn>
          <Btn variant="primary" onClick={() => setModalOpen(true)}>Request a change</Btn>
        </div>
      </div>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="err">{error}</Banner>}
      {lifecycle.message && (
        <div className={`p-4 rounded-lg border flex items-start gap-3 ${lifecycle.isReadOnly ? 'bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]' : lifecycle.isRestricted ? 'bg-[#FFFBEB] border-[#FCD34D] text-[#92400E]' : 'bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]'}`}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div><div className="font-semibold text-[13px]">About your subscription</div><div className="text-[12px] mt-0.5">{lifecycle.message}</div></div>
        </div>
      )}

      <section aria-label="Your plan" className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg"><div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Your plan</div><div className="text-[20px] font-semibold text-[#171717] mt-1">{planName(license.planTier)}</div><div className="text-[12px] text-[#737373]">{modules.filter((m) => m.enabled).length} of {Object.keys(MODULE_META).length} modules included</div></div>
        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg"><div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Valid until</div><div className="text-[20px] font-semibold text-[#171717] mt-1">{fmtDate(license.endDate)}</div><div className="text-[12px] text-[#737373]">{lifecycle.daysRemaining > 0 ? `${num(lifecycle.daysRemaining)} days left` : `Ended ${num(Math.abs(lifecycle.daysRemaining))} days ago`}</div></div>
        <div className="border border-[#E5E5E0] bg-[#FAFAF8] p-4 rounded-lg"><div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Requests</div><div className="text-[20px] font-semibold text-[#171717] mt-1">{anyPending ? 'Waiting' : 'None open'}</div><div className="text-[12px] text-[#737373]">{anyPending ? 'See Request history below' : 'Use Request a change to ask for more'}</div></div>
      </section>
      {lifecycle.status === 'ACTIVE' && lifecycle.daysRemaining > 0 && lifecycle.daysRemaining <= 30 && (
        <p className="text-[12px] text-[#92400E] -mt-4">Your subscription ends in {lifecycle.daysRemaining} days. If it ends, you keep full access for another {license.gracePeriodDays} days (the grace period), then the app becomes read-only. Contact us to renew.</p>
      )}

      <section aria-label="Your plan limits">
        <h2 className="text-[15px] font-semibold text-[#171717]">Your plan limits</h2>
        <p className="text-[12px] text-[#737373] mb-3">What you are using now. Nothing more can be added once a limit is reached.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Limit icon={Users} title="Employees" m={capacity.employees} unit="people" kind="EMPLOYEES" atLimit="The limit is reached, so no more people can be added." />
          <Limit icon={UserCheck} title="User accounts" m={capacity.users} unit="accounts" kind="USERS" atLimit="The limit is reached, so no more accounts can be created." />
          <Limit icon={ShieldCheck} title="Supervisor seats" m={capacity.supervisors} unit="seats" atLimit="All supervisor seats are in use." />
          <Limit icon={Building2} title="Workspaces" m={capacity.workspaces} unit="workspaces" kind="WORKSPACES" atLimit="The limit is reached. Archive one, or ask for more." />
          <Limit icon={Building2} title="Sites" m={capacity.sites} unit="sites" kind="SITES" atLimit="The limit is reached. Close a site, or ask for more." />
        </div>
      </section>

      <section aria-label="What is included">
        <h2 className="text-[15px] font-semibold text-[#171717]">What is included</h2>
        <p className="text-[12px] text-[#737373] mb-3">Modules in your plan are ready to use. The others can be added on request.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Object.entries(MODULE_META).map(([code, meta]) => {
            const isEnabled = !!modules.find((m) => m.moduleCode === code)?.enabled;
            const Icon = meta.icon;
            return (
              <div key={code} className={`p-4 rounded-lg border border-[#E5E5E0] ${isEnabled ? 'bg-white' : 'bg-[#FAFAF8]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2"><Icon className={`w-4 h-4 ${isEnabled ? 'text-[#171717]' : 'text-[#A3A3A3]'}`} /><span className={`font-semibold text-[13px] ${isEnabled ? 'text-[#171717]' : 'text-[#737373]'}`}>{meta.label}</span></div>
                  {isEnabled && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#15803D]"><Check className="w-3.5 h-3.5" />Included</span>}
                </div>
                <p className="text-[12px] text-[#737373] mt-1.5 leading-snug">{meta.desc}</p>
                {!isEnabled && (
                  <div className="mt-2.5 text-[12px]">
                    <span className="text-[#737373]">Not in your plan. </span>
                    {pendingModules.has(code) ? <span className="text-[#B45309]">Requested</span> : <button onClick={() => openRequest('MODULES', [code])} className="font-medium text-[#171717] underline underline-offset-2">Ask about this</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Past Capacity Requests History */}
      {requestsReq.data && requestsReq.data.length > 0 && (
        <div>
          <h2 className="text-[15px] font-semibold text-[#171717] mb-3">Request history</h2>
          <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">Date</th>
                  <th className="py-2.5 px-4">Resource</th>
                  <th className="py-2.5 px-4">Requested Delta</th>
                  <th className="py-2.5 px-4">Your note and our reply</th>
                  <th className="py-2.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E5E0]">
                {requestsReq.data.map((req) => (
                  <tr key={req.id}>
                    <td className="py-2.5 px-4 text-[#737373]">
                      {new Date(req.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 px-4 font-medium">{req.resourceType === 'PLAN' ? 'Plan change' : req.resourceType === 'MODULES' ? 'Modules' : req.resourceType === 'EMPLOYEES' ? 'Employees' : req.resourceType === 'USERS' ? 'Users' : req.resourceType === 'SITES' ? 'Sites' : 'Workspaces'}</td>
                    <td className="py-2.5 px-4 font-medium">{req.resourceType === 'PLAN' ? `Move to ${req.requestedPlan}` : req.resourceType === 'MODULES' ? (req.requestedModules ?? []).map((m) => MODULE_META[m]?.label ?? m).join(', ') : <span className="font-mono">+{req.additionalNeeded}</span>}</td>
                    <td className="py-2.5 px-4 text-[#737373] max-w-xs" title={`${req.justification || ''}${req.decisionNote ? ` | Reply: ${req.decisionNote}` : ''}`}>
                      <div className="truncate">{req.justification || '—'}</div>
                      {req.decisionNote && <div className="truncate text-[#171717]">Reply: {req.decisionNote}</div>}
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
                        {req.status === 'APPROVED' ? 'Approved' : req.status === 'REJECTED' ? 'Declined' : 'Waiting'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <footer className="border-t border-[#E5E5E0] pt-4 text-[12px] text-[#737373] flex flex-wrap gap-x-6 gap-y-1">
        <span>Licence key <span className="font-mono text-[#171717]">{license.licenseKey}</span></span>
        <span>Edition {license.edition.replace(/^WFM_/, '').replace(/_/g, ' ').toLowerCase()}</span>
        <span>Grace period {license.gracePeriodDays} days</span>
        <span>Issued by {license.issuedBy === 'PLATFORM_ADMIN' ? 'your platform provider' : license.issuedBy}</span>
      </footer>

      {planOpen && <PlanChangeModal onClose={() => setPlanOpen(false)} onSubmitted={(m) => { setPlanOpen(false); setNotice(m); setTick((t) => t + 1); }} />}

      {/* Request Capacity Increase Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl border border-[#E5E5E0] w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-[#E5E5E0] flex items-center justify-between">
              <h3 className="font-semibold text-[15px] text-[#171717]">Request a change</h3>
              <button
                onClick={() => setModalOpen(false)}
                aria-label="Close"
                className="text-[#737373] hover:text-[#171717]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={submitRequest} className="p-5 space-y-4">
              <div>
                <label htmlFor="rq-type" className="block text-[12px] font-semibold text-[#171717] mb-1">What do you need more of?</label>
                <select
                  id="rq-type"
                  value={resourceType}
                  onChange={(e) => { const k = e.target.value as typeof resourceType; setResourceType(k); setAdditionalNeeded(k === 'EMPLOYEES' ? 25 : 1); }}
                  className="w-full border border-[#E5E5E0] rounded px-3 py-2 text-[13px] bg-white focus:outline-none focus:border-[#171717]"
                >
                  <option value="EMPLOYEES">Employee seats</option>
                  <option value="USERS">Named user logins</option>
                  <option value="SITES">Sites</option>
                  <option value="WORKSPACES">Workspaces</option>
                  <option value="MODULES">Modules</option>
                </select>
              </div>

              {resourceType === 'MODULES' ? (
                <div>
                  <div className="text-[12px] font-semibold text-[#171717] mb-1.5">Modules you would like added</div>
                  {notEntitled.length === 0 ? <p className="text-[12px] text-[#737373]">Your licence already includes every module.</p> : (
                    <div className="space-y-1.5">
                      {notEntitled.map((code) => (
                        <label key={code} className={`flex items-center gap-2 text-[13px] ${pendingModules.has(code) ? 'text-[#A3A3A3]' : 'text-[#171717]'}`}>
                          <input type="checkbox" disabled={pendingModules.has(code)} checked={wantedModules.includes(code)} onChange={() => setWantedModules((w) => (w.includes(code) ? w.filter((x) => x !== code) : [...w, code]))} />
                          {MODULE_META[code].label}{pendingModules.has(code) ? ' (already requested)' : ''}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[12px] text-[#737373] mb-1">Your limit now</label>
                      <div className="border border-[#E5E5E0] bg-[#FAFAF8] rounded px-3 py-2 text-[13px] font-mono font-medium">{currentCap}</div>
                    </div>
                    <div>
                      <label htmlFor="rq-more" className="block text-[12px] font-semibold text-[#171717] mb-1">How many more</label>
                      <input id="rq-more" type="number" min="1" max="5000" value={additionalNeeded} onChange={(e) => setAdditionalNeeded(Number(e.target.value))} required className="w-full border border-[#E5E5E0] rounded px-3 py-2 text-[13px] font-mono focus:outline-none focus:border-[#171717]" />
                    </div>
                  </div>
                  <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] text-[12px] flex items-center justify-between">
                    <span className="text-[#737373]">Limit if approved:</span>
                    <span className="font-bold text-[14px] text-[#171717] font-mono">{currentCap + Number(additionalNeeded)} {UNIT[resourceType]}</span>
                  </div>
                </>
              )}

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                  Why do you need it?
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
                <Btn variant="primary" type="submit" disabled={submitting || (resourceType === 'MODULES' && wantedModules.length === 0)}>
                  {submitting ? 'Submitting…' : 'Send request'}
                </Btn>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
