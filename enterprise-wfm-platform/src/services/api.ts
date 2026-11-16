/**
 * Gateway client. Everything the forecasting modules show comes from here (Node gateway -> Python engine -> Postgres).
 * Types mirror the gateway's JSON (camelCase); the formatting helpers turn statistics into plain words.
 */

import { markStale, setScope } from './dataCache';

const TOKEN_KEY = 'wfm_token';
const SESSION_KEY = 'wfm_session';
const BASE = '/api/v1';

export type SessionUser = { id: string; userName: string; username: string; email: string | null; role: string; tenantId: string; tenantName: string; orgId?: string; orgName?: string; workspaceId?: string; workspaceName?: string; employeeId: string | null };
export type Tenant = { id: string; name: string; code: string; timezone: string; currency: string; fourEyes: boolean };
export type Workspace = {
  id: string;
  name: string;
  code: string;
  slug: string;
  description: string;
  timezone: string;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED';
  isDefault: boolean;
  role?: string;
  employeeId?: string | null;
  memberCount: number;
  createdAt?: string;
  updatedAt?: string;
};
export type WorkspaceMember = {
  userId: string;
  userName: string;
  username: string;
  email: string | null;
  role: string;
  status: 'ACTIVE' | 'DISABLED';
  isDefault: boolean;
  employeeId: string | null;
  createdAt: string;
};

export type LicenseCapacityMetric = {
  current: number;
  max: number;
  remaining: number;
  percentage: number;
};

export type LicenseRecord = {
  id: string;
  licenseKey: string;
  tenantId: string;
  planTier: string;
  edition: string;
  status: 'DRAFT' | 'ISSUED' | 'PROVISIONING' | 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  gracePeriodDays: number;
  maxEmployees: number;
  maxUsers: number;
  maxSupervisors: number;
  maxSites: number;
  maxWorkspaces: number;
  maxApiCallsPm: number;
  maxStorageGb: number;
  contractId: string | null;
  issuedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type LicenseModule = {
  moduleCode: string;
  enabled: boolean;
  tier: string;
};

export type LicenseUsageReport = {
  license: LicenseRecord;
  modules: LicenseModule[];
  capacity: {
    employees: LicenseCapacityMetric;
    users: LicenseCapacityMetric;
    supervisors: LicenseCapacityMetric;
    workspaces: LicenseCapacityMetric;
    sites: LicenseCapacityMetric;
  };
  lifecycle: {
    status: string;
    daysRemaining: number;
    inGracePeriod: boolean;
    daysInGrace: number;
    isRestricted: boolean;
    isReadOnly: boolean;
    message?: string;
  };
};

export type LicenseCapacityRequest = {
  id: string;
  tenantId: string;
  requestedByUserId: string;
  resourceType: 'EMPLOYEES' | 'USERS' | 'SITES' | 'WORKSPACES' | 'MODULES' | 'PLAN';
  requestedModules?: string[];
  requestedPlan?: string | null;
  decisionNote?: string;
  currentCapacity: number;
  requestedCapacity: number;
  additionalNeeded: number;
  justification: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedByAdmin: string | null;
  reviewedAt: string | null;
  createdAt: string;
  requesterName?: string;
  requesterEmail?: string;
  tenantName?: string;
  tenantCode?: string;
};
export type OrganizationProfile = {
  id: string;
  orgId: string;
  code: string;
  name: string;
  legalName: string;
  displayName: string;
  timezone: string;
  currency: string;
  fourEyes: boolean;
  contactName: string;
  contactEmail: string | null;
  locale: string;
  settings: Record<string, any>;
  createdAt: string;
};
export type Session = {
  /** signed in with a temporary password: only choosing a new one is allowed */
  mustChangePassword?: boolean;
  user: SessionUser;
  tenant: Tenant;
  org?: Tenant;
  workspace?: Workspace;
  workspaces?: Workspace[];
  permissions: string[];
  enabledModules?: string[];
  /** the regions and sites this person is limited to; `restricted` is false for someone who sees the whole organisation */
  access?: { restricted: boolean; regions: { id: string; name: string }[]; sites: { id: string; name: string }[] };
};

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredSession = (): Session | null => {
  try { return getToken() ? JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') : null; } catch { return null; }
};
/** A short id for the current sign-in, so remembered answers are never shown to a different one. */
const scopeOf = (token: string | null) => (token ? token.slice(-24) : '');
export const storeSession = (token: string | null, session: Session | null) => {
  if (token && session) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(SESSION_KEY, JSON.stringify(session)); setScope(scopeOf(token)); }
  else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SESSION_KEY); setScope(''); }
};
setScope(scopeOf(getToken()));

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) { super(message); }
}

async function send(path: string, init: RequestInit, timeoutMs = 0): Promise<Response> {
  const token = getToken();
  const res = await fetch(BASE + path, { ...init, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined, headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    .catch((e) => {
      if (e?.name === 'TimeoutError') throw new ApiError(`This is taking much longer than expected (over ${Math.round(timeoutMs / 60000)} minutes), so it was stopped. Nothing was saved. Try a smaller file, or check the gateway log.`, 0, 'TIMEOUT');
      throw new ApiError('Cannot reach the WFM gateway. Is it running on port 4000?', 0);
    });
  if (res.status === 401 && path !== '/auth/login' && token) { storeSession(null, null); location.reload(); }
  return res;
}

/** The gateway answers errors as { error: { code, message, details } }; tolerate a bare string too. */
async function fail(res: Response): Promise<never> {
  const data: any = await res.json().catch(() => ({}));
  const e = data?.error;
  const message = typeof e === 'string' ? e : e?.message || data?.message || res.statusText || 'Request failed';
  if (e?.code === 'PASSWORD_CHANGE_REQUIRED') {            // a saved session that predates the temporary-password rule: go to the password screen
    const s = getStoredSession();
    if (s && !s.mustChangePassword) { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, mustChangePassword: true })); location.reload(); }
  }
  throw new ApiError(message, res.status, e?.code, e?.details);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const t0 = performance.now();
  const res = await send(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }, opts.timeoutMs);
  if (!res.ok) return fail(res);
  // anything saved, deleted or imported may have changed what is remembered: it is shown if asked for, but fetched again (checks that only look, like a preview, change nothing)
  if (opts.method && opts.method !== 'GET' && !READ_ONLY_POST.test(path)) markStale();
  const body = await res.json().catch(() => ({}));
  recordTiming(opts.method || 'GET', path, performance.now() - t0);
  return body;
}

// ---------------------------------------------------------------- how long each kind of request takes, kept in memory, to find the slow ones
type Timing = { calls: number; totalMs: number; maxMs: number; lastMs: number };
const timings = new Map<string, Timing>();
function recordTiming(method: string, path: string, ms: number) {
  const key = `${method} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')}`;
  const t = timings.get(key) ?? { calls: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  t.calls++; t.totalMs += ms; t.maxMs = Math.max(t.maxMs, ms); t.lastMs = ms;
  timings.set(key, t);
}
/** The slowest requests this tab has made, worst average first. In the browser console: `__wfmTimings()`. */
export function requestTimings(top = 15) {
  return [...timings.entries()].map(([request, t]) => ({ request, calls: t.calls, averageMs: Math.round(t.totalMs / t.calls), maxMs: Math.round(t.maxMs), lastMs: Math.round(t.lastMs) })).sort((a, b) => b.averageMs - a.averageMs).slice(0, top);
}
if (typeof window !== 'undefined') (window as any).__wfmTimings = () => { const r = requestTimings(); console.table(r); return r; };
const READ_ONLY_POST = /\/(preview|check|detect|test|test-pull|suggest|validate|simulate|what-if|dry-run|trace)(\?|$)/;

/** A paged list: the rows of this page and the true number of matches (the gateway's X-Total-Count). */
export async function apiPage<T = any>(path: string): Promise<{ rows: T[]; total: number }> {
  const res = await send(path, { method: 'GET', headers: {} });
  if (!res.ok) return fail(res);
  const rows: T[] = await res.json().catch(() => []);
  const total = Number(res.headers.get('X-Total-Count'));
  return { rows, total: Number.isFinite(total) && res.headers.has('X-Total-Count') ? total : rows.length };
}

export async function download(path: string, fileName: string) {
  const r = await send(path, {});
  if (!r.ok) return fail(r);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob()); a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- workspace & organization API

export async function switchWorkspace(workspaceId: string): Promise<Session> {
  const r = await api<{ token: string } & Session>('/auth/switch-workspace', {
    method: 'POST',
    body: { workspaceId },
  });
  const { token, ...newSession } = r;
  storeSession(token, newSession);
  return newSession;
}

export async function refreshSession(): Promise<Session> {
  const s = await api<Session>('/auth/me');
  storeSession(localStorage.getItem(TOKEN_KEY), s);
  return s;
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  return api<Workspace[]>('/workspaces');
}

export async function createWorkspace(data: {
  name: string;
  code: string;
  slug?: string;
  description?: string;
  timezone?: string;
  currency?: string;
}): Promise<Workspace> {
  return api<Workspace>('/workspaces', { method: 'POST', body: data });
}

export async function updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace> {
  return api<Workspace>(`/workspaces/${id}`, { method: 'PATCH', body: data });
}

export async function archiveWorkspace(id: string): Promise<Workspace> {
  return api<Workspace>(`/workspaces/${id}/archive`, { method: 'POST' });
}

export async function fetchWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return api<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
}

export async function addWorkspaceMember(
  workspaceId: string,
  data: { userId: string; role: string; employeeId?: string | null }
): Promise<WorkspaceMember> {
  return api<WorkspaceMember>(`/workspaces/${workspaceId}/members`, { method: 'POST', body: data });
}

export async function updateWorkspaceMember(
  workspaceId: string,
  userId: string,
  data: { role?: string; status?: string; employeeId?: string | null }
): Promise<WorkspaceMember> {
  return api<WorkspaceMember>(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: data });
}

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  return api<void>(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
}

export async function fetchOrganization(): Promise<OrganizationProfile> {
  return api<OrganizationProfile>('/organization');
}

export async function updateOrganization(data: Partial<OrganizationProfile>): Promise<OrganizationProfile> {
  return api<OrganizationProfile>('/organization', { method: 'PATCH', body: data });
}

// ---------------------------------------------------------------- types

export type Channel = 'VOICE' | 'CHAT' | 'EMAIL' | 'BACKOFFICE';
export type Queue = { shapeFromQueueId?: string | null; aliases?: string[]; volumeBasis?: 'OFFERED' | 'ANSWERED'; abandonRepeatPct?: number; id: string; name: string; code: string; channel: Channel; wfmGroupId: string | null; ahtDefault: number; concurrency: number; openSlot: number; closeSlot: number; slaTargetSeconds: number; slaTargetPercent: number; turnaroundHours: number | null; skillId?: string | null };
export type GroupDto = {
  id: string; name: string; code: string; description: string; timezone: string; status: 'ACTIVE' | 'INACTIVE'; queueIds: string[]; queueNames: string[]; channels: Channel[];
  serviceLevelGoal: number; serviceLevelThresholdSec: number; targetOccupancy: number; shrinkagePercent: number; chatEfficiency?: number; agentCostPerHour?: number | null; method: 'erlang_c' | 'erlang_a'; patienceSec: number;
  blended: boolean; model: string; fteHoursWeek: number;
  /** The shrinkage staffing really uses: the sum of the group's categories when it has any, otherwise the flat percentage. */
  shrinkageEffectivePercent?: number; shrinkageSource?: 'CATEGORIES' | 'FLAT'; shrinkageCategories?: { name: string; pct: number }[]; historyStaleDays?: number;
  /** Weekday a pay week begins on (Monday 0 ... Sunday 6) for this group; null = the company setting. */
  payWeekStart?: number | null;
  /** Weekdays that count as the weekend for this group (Monday 0 ... Sunday 6); null = the company setting. */
  weekendDays?: number[] | null;
  /** The site this group's people work at. */
  siteId?: string | null;
  /** Who manages the group (a person marked as a manager). */
  managerId?: string | null; managerName?: string | null;
  /** The rotation pattern this group normally follows: a ready-made pattern's id, or the id of a pattern in the organisation's library. */
  defaultRotationRef?: string | null;
};
export type Group = GroupDto & { queues: Queue[] };
export type ShrinkageCategory = { id: string; name: string; pct: number; sort: number };

export type VersionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export type VersionKind = 'SHORT' | 'LONG';
export type VersionMeta = {
  id: string; seq: number; wfmGroupId: string; name: string; kind: VersionKind; type: string; status: VersionStatus; fromDay: string; toDay: string;
  slotsPerDay: number; modelReq: string; model?: string | null; wape?: number | null; rev: number; parentVersionId: string | null; createdBy: string | null; createdAt: string;
  submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; publishedBy: string | null; publishedAt: string | null;
};
export type Bucket = {
  day: string; slot: number; volume: number; aht: number; p10: number; p90: number; edited: boolean;
  required: number; base: number; sl: number; occ: number; warn: boolean;
  /** short-term intervals only: what really happened, the same weekday a week earlier, and people on the published schedule (null = not there yet) */
  actual?: number | null; lastWeek?: number | null; scheduled?: number | null;
  peakRequired?: number; agentHours?: number; minSl?: number; warnIntervals?: number; period?: string; days?: number;
};
export type Score = { model: string; wape: number; mase: number; bias: number; selected: boolean; mae: number; rmse: number; mape: number; stability: 'HIGH' | 'MEDIUM' | 'VARIABLE' };
export type Series = {
  queueId: string | null; name: string; model: string; scores: Score[]; backtest: { day: string; volume: number; aht_sec: number }[];
  notes: string[]; cleanedDays: number; sigmaRel: number; bands?: BandInfo | null;
};
/** How the P10-P90 band was made and how it held up on days it was not fitted to (coverage: about 0.10 and 0.90 is calibrated; -1 = not measured). */
export type RegistryRow = { id: string; queueId: string | null; queueName: string; model: string; modelVersion: string; engineVersion: string | null; training: { from: string; to: string; rows: number; dataHash: string }; generatedBy: string | null; generatedAt: string };
export type BandInfo = { method: 'EMPIRICAL' | 'NORMAL' | null; p10Coverage: number; p90Coverage: number; points: number };
export type AuditEntry = { at: string; by: string; role: string; action: string; reason: string | null; detail: any };
export type VersionFull = VersionMeta & { summary: { series: Series[] }; audit: AuditEntry[] };
export type DataResp = {
  version: VersionMeta; grain: string; from: string; to: string; buckets: Bucket[]; queues: { id: string; name: string; channel: string }[];
  group: { id: string; name: string; serviceLevel: number; answerSec: number; shrinkage: number; occupancyCap: number; method: string };
};
export type LeaderRow = {
  modelId: string; modelName: string; rank: number; isRecommended: boolean; wapePercent: number; rawWapePercent?: number | null; rawBiasPercent?: number | null; rawMae?: number | null; accuracyBasis?: string; mapePercent: number; mae: number; rmse: number; biasPercent: number;
  stabilityScore: 'HIGH' | 'MEDIUM' | 'VARIABLE'; stability: string; vsBaselinePercent: number; recommendationReason: string; backtestPeriod: string;
};
export type Leaderboard = { versionId: string; queueId: string | null; queueName: string; baselineWapePercent: number | null; cleanedDays: number; bands?: BandInfo | null; notes: string[]; rows: LeaderRow[]; series: { queueId: string | null; name: string }[] };

export const MODEL_LABEL: Record<string, string> = {
  auto: 'Auto (most accurate wins)', snaive: 'Same as last week', wavg: 'Weighted weekly average', ets: 'Holt-Winters (ETS)',
  gbm: 'Gradient boosting', combo: 'Ensemble (blend of models)', croston: 'Croston (sparse queues)',
  sarima: 'Seasonal ARIMA (SARIMA)', arima: 'ARIMA with weekday effects', lstm: 'LSTM neural network',
};
export const CHANNEL_LABEL: Record<string, string> = { VOICE: 'Voice', CHAT: 'Chat', EMAIL: 'Email', BACKOFFICE: 'Back office' };

// ---------------------------------------------------------------- formatting

const p2 = (n: number) => String(n).padStart(2, '0');
export const slotLabel = (s: number) => `${p2(Math.floor(s / 4))}:${p2((s % 4) * 15)}`;
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
export const int = (v: number) => Math.round(v).toLocaleString();
export const dec = (v: number, d = 1) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
/** 0.72 (error vs a "same as last week" guess) -> "28% better". */
export const vsBase = (mase: number) => (Math.abs(mase - 1) < 0.005 ? 'same' : mase < 1 ? `${Math.round((1 - mase) * 100)}% better` : `${Math.round((mase - 1) * 100)}% worse`);
export const lean = (b: number, d = 1) => (Math.abs(b) < 0.0005 ? 'on target' : `${b > 0 ? 'over' : 'under'} ${(Math.abs(b) * 100).toFixed(d)}%`);
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
export const dayName = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
export const dayYear = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
export const isNew = (v: { createdAt: string }) => Date.now() - new Date(v.createdAt).getTime() < 15 * 60 * 1000;

export const fmtDate = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); };

export const STATUS_FLOW: VersionStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PUBLISHED'];
export const STATUS_LABEL: Record<VersionStatus, string> = { DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', PUBLISHED: 'Published', ARCHIVED: 'Archived' };

// ---------------------------------------------------------------- workforce and scheduling (phase 2)

export type Skill = { id: string; name: string; code: string; category: 'CHANNELS' | 'LANGUAGES' | 'PRODUCTS' | 'TIERS'; type: 'CORE' | 'SECONDARY' | 'SPECIALTY'; status: 'ACTIVE' | 'INACTIVE'; requiresCertification: boolean; description: string; holders: number; activeHolders?: number; levels?: number[]; requiredBy?: { groupId: string; groupName: string; minProficiency: number; qualified: number }[]; risk?: { level: 'NONE' | 'THIN' | 'OK'; reason: string | null; requiredByGroups: number; fixGroupId?: string | null } };
export type Team = { id: string; name: string; code: string; description: string; location: string; managerId: string | null; managerName: string | null; deputyId?: string | null; deputyName?: string | null; status: 'ACTIVE' | 'INACTIVE'; memberCount: number };
export type EmployeeStatus = 'ONBOARDING' | 'ACTIVE' | 'LEAVE' | 'SUSPENDED' | 'TERMINATED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACTOR' | 'TEMPORARY';
/** Same start and end time every day: DEFAULT follows the company setting. */
export type ShiftConsistency = 'DEFAULT' | 'REQUIRE' | 'PREFER' | 'OFF';
export type Employee = {
  id: string; employeeNumber: string; firstName: string; lastName: string; name: string; email: string | null; phone: string; extension: string | null; timezone: string | null; status: EmployeeStatus; hireDate: string | null;
  teamId: string | null; teamName: string | null; location: string; employmentType: EmploymentType; weeklyContractHours: number; maxWeeklyHours: number; workDaysPerWeek: number; minRestHours: number;
  maxConsecutiveDays: number; allowWeekend: boolean; allowOvernight: boolean; nightShiftConsent: boolean; primaryGroupId: string | null; primaryGroupName: string | null; eligibleGroupIds: string[]; version: number;
  preferredTemplateId: string | null; preferredTemplateName: string | null;
  shiftConsistency: ShiftConsistency; fixedStartSlot: number | null;
  /** May be chosen as a team's supervisor / a group's manager. Only says what the person is: access comes from the role on their login. */
  isSupervisor?: boolean; isManager?: boolean;
  /** Who they report to (the org chart), and the last working day and reason when they are leaving. */
  reportsTo?: string | null; reportsToName?: string | null; terminationDate?: string | null; terminationReason?: string | null;
  skills: { skillId: string; name: string; code: string; proficiency: number }[];
};
export type AvailabilityWindow = { id?: string; dayOfWeek: number; startTime: string; endTime: string; kind: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED'; effectiveFrom?: string | null; effectiveTo?: string | null };
export type TimeOff = { id: string; employeeId: string; employeeName: string; type: string; startDate: string; endDate: string; days: number; status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason: string; decidedBy: string | null; decidedAt: string | null; createdAt: string; escalatedAt?: string | null; decidedLevel?: 'SUPERVISOR' | 'MANAGER' | null };
export type ShiftTemplate = {
  id: string; name: string; code: string; description: string; status: 'ACTIVE' | 'INACTIVE'; workDays: number[]; earliestStart: string; latestStart: string; startStepMinutes: number;
  durationHours: number; paidHours: number; mealMinutes: number; breakCount: number; breakMinutes: number; flexMinutes: number; version: number;
  mealAnchorMinutes: number | null; breakAnchorMinutes: (number | null)[] | null;
  /** Variable length: the shortest shift in hours (null = fixed at durationHours, which is then the longest) and the gap between offered lengths. */
  minDurationHours?: number | null; lengthStepMinutes?: number; mealPaid?: boolean; paidHoursMin?: number;
  /** A split shift: the "meal" is an unpaid gap of 1 to 6 hours between two parts of the day. */
  splitShift?: boolean;
  /** A different start window on some weekdays, keyed by weekday number (Monday = 0). */
  dayWindows?: Record<string, { earliest: string; latest: string }> | null;
  /** Meal and breaks by shift length: the rule with the largest fromHours not above the length applies. */
  lengthRules?: { fromHours: number; mealMinutes: number; breakCount: number; breakMinutes: number }[] | null;
  /** Who it is offered to (null = everyone) and the dates it is in force. */
  groupIds?: string[] | null; employmentTypes?: string[] | null; skillIds?: string[] | null; effectiveFrom?: string | null; effectiveTo?: string | null;
};
export type SolverInfo = { status: string; gap: number; wallSec: number; variables: number; constraints: number; objective: number; candidates: number; people: number; backend?: string; attempts?: string[]; windowed?: boolean; score?: number | null; scoreTerms?: { name: string; value: number }[] } | null;
export type ScheduleStats = {
  solver: SolverInfo; coverage: { percent: number; requiredSlots: number; underSlots: number; overSlots: number; underIntervals: number; criticalIntervals: number };
  hours: { paid: number; overtime: number; required: number; premium?: number }; shifts: number; people: number; violations: number; warnings?: number; uncoveredDays?: string[]; projectedDays?: string[];
};
export type CoverageWindow = { id: string; dayOfWeek: number; startTime: string; endTime: string; headcount: number };
export type ScheduleVersion = {
  id: string; seq: number; wfmGroupId: string; groupName?: string | null; name: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; kind?: 'DEMAND' | 'ROTATION'; coverageSource?: 'FORECAST' | 'MANUAL'; periodStart: string; periodEnd: string; forecastVersionId: string | null; forecastName: string | null;
  rev: number; hasChanges: boolean; stats: ScheduleStats; settings: any; createdBy: string | null; createdAt: string; publishedBy: string | null; publishedAt: string | null;
  violations?: Violation[];
  /** Why this schedule no longer matches the forecast it was built from (empty while current). */
  stale?: string[];
  acknowledged?: { by: string; at: string; reason: string; issues: string[] } | null;
  /** Where a draft stands in review. `changedSince`: it was edited after it was submitted or approved, so that review no longer counts. */
  approval?: { state: 'NONE' | 'SUBMITTED' | 'APPROVED'; changedSince: boolean; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; note: string | null };
  /** A schedule can be published up to a date; later weeks stay planned. null = published in full (or a draft). */
  publishThrough?: string | null;
};
export type Verdict = { valid: boolean; status: 'VALIDATED' | 'VALIDATED_WITH_WARNINGS' | 'INVALID'; coverageStatus: 'ADEQUATE' | 'UNDERSTAFFED'; hardViolations: number; softWarnings: number; coveragePercent: number; underHours: number; fairnessSpreadHours: number;
  findings: { severity: 'HARD' | 'SOFT'; code: string; employeeName: string | null; day: string | null; message: string }[]; days: { day: string; coveragePercent: number; underHours: number }[] };
export type PublishImpact = {
  previous: { id: string; name: string }[]; noticeHours: number; today: string;
  totals: { people: number; added: number; removed: number; changed: number; unchanged: number; hoursDelta: number; shortNotice: number };
  people: { employeeId: string; name: string; added: number; removed: number; changed: number; hoursDelta: number; shortNotice: number; changes: { day: string; kind: 'ADDED' | 'REMOVED' | 'CHANGED'; from: { start: string; end: string } | null; to: { start: string; end: string } | null; shortNotice: boolean }[] }[];
};
export type Violation = { type: string; employeeId: string; employeeName: string; day: string; message: string; severity?: 'BLOCK' | 'WARN' };
export type ScheduleShift = {
  id: string; employeeId: string; employeeName: string; employeeNumber: string; teamName?: string | null; day: string; templateId: string | null; templateName: string | null; startTime: string; endTime: string;
  startSlot: number; lengthSlots: number; overnight: boolean; source: 'SOLVER' | 'MANUAL' | 'ROTATION' | 'PATTERN'; activities: { type: 'MEAL' | 'BREAK'; startSlot: number; slots: number; startTime: string; endTime: string }[];
};

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const EMP_STATUS_LABEL: Record<EmployeeStatus, string> = { ONBOARDING: 'Onboarding', ACTIVE: 'Active', LEAVE: 'On leave', SUSPENDED: 'Suspended', TERMINATED: 'Terminated' };
export const TYPE_LABEL: Record<EmploymentType, string> = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contractor', TEMPORARY: 'Temporary' };
/** Monday on or after today (local), as YYYY-MM-DD: the natural start of a schedule. */
export const nextMonday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((7 - ((d.getDay() + 6) % 7)) % 7)); return fmtDate(d); };
export const dowOfDay = (s: string) => (new Date(s + 'T00:00:00').getDay() + 6) % 7;
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** First day of the pay week that `day` falls in. weekStart: Monday 0 ... Sunday 6. */
export const weekFloor = (day: string | Date, weekStart = 0) => {
  const d = typeof day === 'string' ? new Date(day + 'T00:00:00') : new Date(day);
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((((d.getDay() + 6) % 7) - weekStart + 7) % 7));
  return fmtDate(d);
};
/** The first day of a pay week on or after `plusDays` days from today. */
export const nextWeekStart = (weekStart = 0, plusDays = 0) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + plusDays);
  d.setDate(d.getDate() + ((weekStart - ((d.getDay() + 6) % 7) + 7) % 7));
  return fmtDate(d);
};
/** The seven weekday names in pay-week order, starting with the weekday the pay week begins on. */
export const weekOrder = <T,>(names: T[], weekStart = 0) => Array.from({ length: 7 }, (_, i) => names[(weekStart + i) % 7]);
export type PayWeekInfo = { start: number; source: 'GROUP' | 'COMPANY' | 'DEFAULT'; companyStart: number };
export const slotHHMM = (s: number) => `${p2(Math.floor(s / 4) % 24)}:${p2((s % 4) * 15)}`;
export const SCHED_STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' };

export type Activity = { id: string; name: string; code: string; shortCode: string; category: 'WORK' | 'BREAK' | 'MEAL' | 'TRAINING' | 'MEETING' | 'COACHING' | 'ABSENCE' | 'OTHER'; countsAsWork: boolean; paid: boolean; shrinkage: boolean; ignoreAdherence: boolean; color: string; textColor: string | null; status: 'ACTIVE' | 'INACTIVE'; version: number };
export const ACTIVITY_CATEGORY_LABEL: Record<Activity['category'], string> = { WORK: 'Queue work', BREAK: 'Break', MEAL: 'Meal', TRAINING: 'Training', MEETING: 'Meeting', COACHING: 'Coaching', ABSENCE: 'Absence', OTHER: 'Other' };
export type SchedulingPolicy = { minRestHours: number | null; maxWeeklyHours: number | null; maxConsecutiveDays: number | null; maxDaysPerWeek: number | null; adherenceGraceSeconds: number; timelineColors: { shift: string; manual: string; violation: string }; weights: Record<'understaffing' | 'overstaffing' | 'contractHours' | 'preferences' | 'fairness', number>; scheduling: SchedulingDefaults; updatedBy: string | null; updatedAt: string | null };
export type ConsistentTimes = { mode: 'OFF' | 'PREFER' | 'REQUIRE'; startToleranceMin: number; endToleranceMin: number };
export type SchedulingDefaults = { consistentTimes: ConsistentTimes; targetCoverage: number; enforcePublishChecks: boolean; breakSlackMin: number; payWeekStart: number; weekendDays: number[]; partTimeToleranceHours: number | null; overtime?: 'FREE' | 'WHEN_SHORT' | 'NEVER'; holidays?: 'ALLOW' | 'AVOID' | 'CLOSED'; requireApproval?: boolean; changeNoticeHours?: number };

// ---- schedule quality: report, evaluation, shortage
export type ReportException = { level: 'WARNING' | 'INFO'; code: string; subject: string; message: string; people?: { id: string; name: string }[] };
export type GenerationReport = { available: boolean; status?: 'SUCCEEDED' | 'SUCCEEDED_WITH_WARNINGS'; people?: { inPool: number; scheduled: number; notScheduled: number; noPossibleShift: number }; exceptions?: ReportException[]; unscheduled?: { id: string; employeeNumber: string; name: string; reason: string }[]; breaks?: { shiftsChanged: number; phoneShortfallBefore: number; phoneShortfallAfter: number } | null };
export type Evaluation = {
  available: boolean; reason?: string; score: number; grade: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  summary: { method: string; target: number; answerSec: number; serviceLevel: number; serviceLevelBusyDay: number; serviceLevelQuietDay: number; volumeMeetingTarget: number; intervals: number; intervalsBelowTarget: number; averageOccupancy: number; breakShare: number };
  parts: { key: string; label: string; max: number; points: number; detail: string }[];
  byDay: { day: string; volume: number; serviceLevel: number; intervalsBelowTarget: number }[];
  worst: { day: string; slot: number; time: string; volume: number; scheduled: number; onPhones: number; sl: number; slLow: number; slHigh: number; asa: number }[];
};
export type ShortageBlock = { day: string; from: string; to: string; peakShort: number; shortPeopleHours: number; requiredPeak: number; scheduledMin: number; causes: { key: string; people: number; text: string }[]; actions: { type: string; label: string; detail: string; proposal?: TemplateProposal }[] };
/** A shift template that would cover a gap nobody can cover today, with an estimate of what it frees up. */
export type TemplateProposal = { name: string; earliestStart: string; latestStart: string; durationHours: number; mealMinutes: number; breakCount: number; breakMinutes: number; workDays: number[]; days: { day: string; eligible: number }[]; gainPeopleHours: number; coverageBefore: number; coverageAfter: number };
export type Shortage = { targetCoverage: number; coveragePercent: number; meetsTarget: boolean; intervalsShort: number; gaps: number; shortPeopleHours: number; headline: string; topCauses: { key: string; weight: number; text: string }[]; blocks: ShortageBlock[] };

export type GroupActivity = Activity & { enabled: boolean; overridden: boolean; companyShrinkage: boolean; companyPaid: boolean };
export type StateMapping = { id: string; state: string; reason: string; activityId: string | null; activityName: string | null };
export type AdherenceStatus = 'IN' | 'OUT' | 'UNSCHEDULED' | 'IGNORED' | 'UNKNOWN' | 'NOT_STARTED' | 'SHIFT_ENDED';
export type AdherenceAgent = { employeeId: string; employeeNumber: string; name: string; team: string | null; timezone: string; shift: string | null; scheduled: string; scheduledUntil: string | null; actual: string; state: string | null; reason: string; stateSince: string | null; status: AdherenceStatus; outMinutes: number; outSeconds: number; dayPercent: number | null;
  timeline: { schedule: { from: number; to: number; type: string }[]; actual: { from: number; to: number; status: AdherenceStatus; label: string }[] };
  exceptions: { id: string; from: number; to: number; category: string; note: string; excused: boolean; createdBy: string | null }[] };
export type Adherence = {
  day: string; asOf: string | null; timezone: string; graceSeconds: number; publishedSchedule: boolean; hasEvents: boolean;
  summary: { total: number; inAdherence: number; outOfAdherence: number; unscheduled: number; ignored: number; unknown: number; dayPercent: number | null };
  unmappedStates: { state: string; reason: string; agents: number }[]; agents: AdherenceAgent[];
  staffing: { slot: number; time: string; published: number; actual: number | null }[];
};
// the paged adherence screen: a summary, a page of people at a time (no timelines), and one person with their timeline
export type AdherenceLite = Omit<AdherenceAgent, 'timeline' | 'exceptions'> & { scheduledMin: number; adherentMin: number };
export type AdherenceDetail = AdherenceAgent & { day: string; scheduledMin: number; adherentMin: number };
export type AdherenceTeam = { team: string | null; total: number; inAdherence: number; outOfAdherence: number; unscheduled: number; ignored: number; unknown: number; dayPercent: number | null };
export type AdherenceSummary = Omit<Adherence, 'agents'> & { teams: AdherenceTeam[]; scope: 'all' | 'mine'; myTeams: string[]; ageSeconds: number };
export type AdherenceHistory = {
  by: 'agent' | 'team'; from: string; to: string; building: number; overall: { percent: number | null; people: number; scheduledMin: number };
  series: { day: string; percent: number | null; people: number }[];
  rows: { employeeId?: string; name: string; employeeNumber: string | null; team: string | null; people: number; scheduledMin: number; adherentMin: number; percent: number | null }[];
};
export type SavedView = { id: string; name: string; filters: Record<string, any> };
export type CoverageSlot = { slot: number; time: string; forecast: number; forecastLow: number; forecastHigh: number; historical: number | null; aht: number | null; serviceLevel: number | null; occupancy: number | null; edited: boolean; actual: number | null; reforecast: number | null; abandoned: number | null; required: number; requiredReforecast: number | null; scheduled: number };
export type Coverage =
  | { day: string; ready: false; reason: string }
  | {
    day: string; ready: true; timezone: string; nowSlot: number; nowTime: string | null; forecastName: string; hasActuals: boolean; hasSchedule: boolean; first: number; last: number;
    reforecast: { applied: boolean; ratio: number; credibility: number };
    totals: { forecastSoFar: number; actualSoFar: number; forecastDay: number; reforecastDay: number | null };
    gaps: { slot: number; time: string; gap: number }[]; slots: CoverageSlot[]; versionId: string; versionStatus: string;
    stats: { wape: number | null; coveragePercent: number | null; peakRequired: number; ahtAvg: number | null; serviceLevel: number | null; occupancy: number | null };
  };

// ---------------------------------------------------------------- forecast self-learning
export type LearningQueue = { queueId: string; name: string; days: number; wape: number | null; bias: number | null; factors: number[]; samples: number[] };
export type LearningRun = { id: number; at: string; trigger: 'DATA' | 'MANUAL' | 'SCHEDULE'; days: number; wape: number | null; bias: number | null; drift: boolean; action: 'NONE' | 'CORRECTIONS_UPDATED' | 'DRAFT_CREATED'; versionId: string | null; note: string };
export type Learning = {
  enabled: boolean;
  limits: { wape: number; bias: number; minDays: number; windowDays: number; minSamples: number };
  evaluation: { from: string; to: string; days: number; wape: number | null; bias: number | null; drift: boolean; queues: LearningQueue[] };
  runsWindowDays: number;
  factors: { queueId: string; queueName: string; dow: number; factor: number; samples: number; updatedAt: string }[];
  runs: LearningRun[];
};

// ---------------------------------------------------------------- time & attendance
export type Punch = { id: string; employeeId: string; employeeName: string; day: string; clockIn: string; clockOut: string | null; hours: number | null; source: 'IMPORT' | 'MANUAL'; note: string };
export type AttendanceIssue = 'missed' | 'late' | 'early' | 'open' | 'unscheduled' | 'upcoming' | 'excused' | 'ok';
export type AttendanceReason = 'APPROVED_ABSENCE' | 'CLOCK_FAULT' | 'SYSTEM_OUTAGE' | 'WORKED_ELSEWHERE' | 'MANAGER_OVERRIDE' | 'OTHER';
export type AttendanceExcuse = { id: string; kind: 'missed' | 'late' | 'early' | 'open'; reasonCode: AttendanceReason; note: string; paid: boolean; level: 'SUPERVISOR' | 'MANAGER'; by: string; at: string };
export type AttendanceDay = { employeeId: string; employeeNumber: string; name: string; day: string; scheduledHours: number; actualHours: number; varianceHours: number; status: 'MATCHED' | 'MISSED' | 'UNSCHEDULED' | 'OPEN' | 'UPCOMING' | 'EXCUSED'; excused: AttendanceExcuse[]; paidExcuse: boolean; lateMinutes: number; earlyLeaveMinutes: number; due: boolean; issues: AttendanceIssue[]; shift: string | null; punches: { id: string; clockIn: string; clockOut: string | null; source: 'IMPORT' | 'MANUAL' }[] };
export type AttendanceWeek = { employeeId: string; employeeNumber: string; name: string; weekStart: string; actualHours: number; scheduledHours: number; overtimeHours: number };
export type AttendanceSummary = { days: AttendanceDay[]; weeks: AttendanceWeek[] };
export type AttendanceCounts = Record<AttendanceIssue, number> & { total: number; punches: number; dueScheduled: number };
export type AttendancePerson = { employeeId: string; employeeNumber: string; name: string; scheduledHours: number; actualHours: number; varianceHours: number; overtimeHours: number; problems: { missed: number; late: number; early: number; open: number }; days: AttendanceDay[] };
export type AttendanceWeekView = { from: string; to: string; payStart: number; graceMinutes: number; counts: AttendanceCounts; feedMissing: boolean; total: number; people: AttendancePerson[] };
export type ImportResult = { dryRun: boolean; rowsRead: number; newPunches: number; alreadyImported: number; errors: { line: number; message: string }[]; errorCount: number; committed: boolean };

// ---------------------------------------------------------------- rotating rosters
export type RotationCrew = { name: string; offsetDays: number };
export type RotationStep = { name: string; weeks: number; days: (string | null)[] };
export type RotationPattern = { id: string; wfmGroupId: string; name: string; cycleDays: number; sequence: (string | null)[]; crews: RotationCrew[]; anchorDate: string; status: 'ACTIVE' | 'INACTIVE'; observesHolidays: boolean; versionId: string | null; materializedThrough: string | null; memberCount: number; version: number; createdBy: string | null; createdAt: string;
  /** DAY_CYCLE: a sequence of days. WEEKLY: weekly templates (steps), each worked for some weeks; `sequence` is then the day cycle they unroll to. */
  kind: 'DAY_CYCLE' | 'WEEKLY'; steps: RotationStep[] | null; templateRef?: string | null; effectiveFrom?: string | null };
export type RotationAnalysis = {
  cycleDays: number; payWeekStart: number; contractHours: number | null;
  crews: { name: string; offsetDays: number; shiftsPerCycle: number; paidHoursPerCycle: number; averageWeeklyHours: number; maxHoursInAnyWeek: number; maxDaysInAnyWeek: number; longestRun: number; neverOff: boolean; shortestRestHours: number | null; weekendDaysPerWeek: number; weekendsFullyOff: number }[];
  findings: { level: 'WARN' | 'INFO' | 'OK'; text: string }[];
  /** Checked against the customer's labour-law pack; `applied` is false when none is assigned. */
  legal?: { applied: boolean; packName: string | null; findings: { severity: 'BLOCK' | 'WARN'; rule: string; label: string; count: number; example: string | null }[] };
  /** What each crew carries over a year. */
  fairness?: { perCrew: { crew: string; shiftsPerYear: number; nightsPerYear: number; weekendDaysPerYear: number; sundaysPerYear: number; holidaysWorkedPerYear: number | null }[]; notes: string[]; nightHours?: unknown };
};
export type RotationRevision = { version: number; effectiveFrom: string | null; effectiveTo: string | null; name: string; kind: 'DAY_CYCLE' | 'WEEKLY'; cycleDays: number; changedBy: string | null; changedAt: string; note: string | null };
export type RotationPreview =
  | { available: false; reason: string }
  | { available: true; from: string; days: number; people: number; uncoveredDays: string[];
      summary: { requiredHours: number; scheduledHours: number; shortHours: number; overHours: number; coveragePercent: number; worstShort: { day: string; time: string; short: number } | null };
      daily: { day: string; requiredHours: number; scheduledHours: number; shortHours: number; overHours: number; coveragePercent: number; noTarget: boolean }[];
      heat: { day: string; hours: { need: number; have: number }[] }[] };
export type RotationMember = { employeeId: string; name: string; employeeNumber: string; crewName: string; startCycleDay: number | null; effectiveFrom: string | null; effectiveTo: string | null };

// ---------------------------------------------------------------- Integration Station
export type IntegrationField = { key: string; label: string; kind: 'text' | 'password' | 'file' | 'select' | 'textarea'; options?: string[]; help?: string; required?: boolean };
export type IntegrationReadiness = { level: 'VERIFIED' | 'TESTED' | 'FROM_DOCS' | 'NOT_READY'; label: string; note: string };
export type IntegrationGuide = { what: string; needs: string[]; limits: string[] };
export type IntegrationPreset = { id: string; label: string; method: string; authType: string; fields: IntegrationField[]; note: string | null; guide?: IntegrationGuide | null; readiness?: IntegrationReadiness; writesTo: string; canPull?: boolean };
export type IntegrationCatalog = Record<string, IntegrationPreset[]>;
export type Connector = {
  id: string; wfmGroupId: string | null; category: string; method: string; preset: string; name: string; status: string; config: Record<string, string>;
  lastReceivedAt: string | null; lastError: string | null; lastSample: unknown; connectedAt: string | null; backfillStatus: string; backfillThrough: string | null; hasWebhookSecret: boolean; createdBy: string | null; createdAt: string;
  scheduleMin: number | null; scheduleAt: string | null; scheduleDays: number[] | null; nextRunAt: string | null; rows24h?: number | null; canPull: boolean; note: string;   // whether the server can pull this source itself, and why not
};
export type ConnectorCreated = Connector & { apiKey: string | null; webhookSecret: string | null; webhookUrl: string | null };
export type IntegrationFieldMap = { targetField: string; sourcePath: string; transform: string | null };
export type EntitySuggestion = { sourceId: string; sourceLabel: string; targetId: string | null; targetName: string | null; score: number };
export type EntityMatchRow = { entityType: string; sourceId: string; sourceLabel: string; targetId: string | null };
export type EventRule = { eventType: string; action: 'PENDING' | 'STATE' | 'SKIP'; state: string | null; reason: string | null; seenCount: number; lastSeenAt: string };
export type FeedOutcome = 'ACCEPTED' | 'IGNORED' | 'WAITING' | 'REJECTED';
export type FeedEvent = { at: string; eventType: string | null; sourceId: string | null; outcome: FeedOutcome; state: string | null; reason: string | null; message: string | null; raw: unknown };
export type AgentSuggestion = { kind: 'EXACT' | 'LIKELY'; employeeId: string; employeeName: string; why: string } | { kind: 'AMBIGUOUS' | 'NONE'; why: string };
export type FeedAgent = { sourceId: string; seenCount: number; firstSeenAt: string; lastSeenAt: string; lastEventType: string | null; matched: boolean; via: string | null; employee: { id: string; name: string; number: string } | null; suggestion: AgentSuggestion | null };
export type EventTypeSuggestion = { kind: 'SKIP' | 'OWN_STATE' | 'UNKNOWN'; why: string } | { kind: 'STATE'; state: string; reason: string | null; why: string };
export type ActivitySuggestion = { kind: 'ACTIVITY'; activityId: string; activityName: string; why: string } | { kind: 'NOT_WORKING' | 'NONE'; why: string };
export type FeedReview = {
  eventTypes: { eventType: string; seenCount: number; lastSeenAt: string; action: 'PENDING' | 'STATE' | 'SKIP'; state: string | null; reason: string | null; needsDecision: boolean; suggestion: EventTypeSuggestion }[];
  states: { state: string; reason: string; seenCount: number; lastSeenAt: string; mapped: boolean; suggestion: ActivitySuggestion }[];
  agents: { seen: number; matched: number; unmatched: number; exact: number; likely: number };
};
export type MapTestResult = { raw: unknown; mapped: Record<string, unknown>; resolved: Record<string, unknown>; issues: string[]; notes: string[]; ok: boolean };

// ---------------------------------------------------------------- dynamic break re-optimization
export type BreakSuggestion = { shiftId: string; employeeName: string; type: 'MEAL' | 'BREAK'; fromSlot: number; toSlot: number; from: string; to: string; deficitReduction: number };
export type BreakSuggestions = { day: string; ready: boolean; reason?: string; nowTime?: string | null; reforecastApplied?: boolean; suggestions: BreakSuggestion[] };

/** A background schedule build or re-solve. */
export type ScheduleJob = {
  id: string; groupId: string; kind: 'PLAN' | 'RESOLVE'; status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'; versionId: string | null; error: string | null; cancelRequested: boolean;
  createdAt: string; startedAt: string | null; finishedAt: string | null; createdBy: string | null; params: { from: string | null; weeks: number | null; versionId: string | null };
  progress: { done?: number; total?: number; note?: string; etaSec?: number | null; windows?: { from: string; to: string; kind: 'SOLVED' | 'PATTERN'; coverage: number | null; backend: string | null; status: string; shifts: number; note?: string }[] };
};
export type PlanWeek = {
  weekStart: string; weekEnd: string; /** days of this week that are inside the schedule (7 unless it starts or ends mid-week) */ days?: number; coveragePercent: number | null; needSlots: number; underSlots: number; overSlots: number; shifts: number; people: number;
  shiftSource: 'SOLVED' | 'PATTERN' | 'MIXED' | 'EMPTY'; forecast: 'SHORT' | 'LONG' | 'MIXED' | 'NONE'; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'; weeksAhead: number; state: 'LOCKED' | 'PARTLY_LOCKED' | 'PAST' | 'PLANNED';
};
export type PlanView = { versionId: string; name: string; status: string; periodStart: string; periodEnd: string; /** the pay week's first day, Monday 0 ... Sunday 6 */ weekStartDay?: number; publishThrough: string | null; today: string; plan: any; weeks: PlanWeek[]; summary: { coverage: number; shifts: number; people: number; violations: number } };
export type RotationLines = { versionId: string; from: string; to: string; cycleWeeks: number; peopleOnLines: number; lines: { id: string; name: string; size: number; summary: string; weeks: { week: number; text: string; days: { day: string; shift: string }[] }[]; people: { id: string; name: string; number: string }[] }[] };
