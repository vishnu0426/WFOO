/**
 * Gateway client. Everything the forecasting modules show comes from here (Node gateway -> Python engine -> Postgres).
 * Types mirror the gateway's JSON (camelCase); the formatting helpers turn statistics into plain words.
 */

const TOKEN_KEY = 'wfm_token';
const SESSION_KEY = 'wfm_session';
const BASE = '/api/v1';

export type SessionUser = { id: string; userName: string; username: string; email: string | null; role: string; tenantId: string; tenantName: string; employeeId: string | null };
export type Tenant = { id: string; name: string; code: string; timezone: string; currency: string; fourEyes: boolean };
export type Session = { user: SessionUser; tenant: Tenant; permissions: string[] };

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredSession = (): Session | null => {
  try { return getToken() ? JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') : null; } catch { return null; }
};
export const storeSession = (token: string | null, session: Session | null) => {
  if (token && session) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SESSION_KEY); }
};

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
  throw new ApiError(message, res.status, e?.code, e?.details);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const res = await send(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }, opts.timeoutMs);
  if (!res.ok) return fail(res);
  return res.json().catch(() => ({}));
}

export async function download(path: string, fileName: string) {
  const r = await send(path, {});
  if (!r.ok) return fail(r);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob()); a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- types

export type Channel = 'VOICE' | 'CHAT' | 'EMAIL' | 'BACKOFFICE';
export type Queue = { id: string; name: string; code: string; channel: Channel; wfmGroupId: string | null; ahtDefault: number; concurrency: number; openSlot: number; closeSlot: number; slaTargetSeconds: number; slaTargetPercent: number; turnaroundHours: number | null };
export type GroupDto = {
  id: string; name: string; code: string; description: string; timezone: string; status: 'ACTIVE' | 'INACTIVE'; queueIds: string[]; queueNames: string[]; channels: Channel[];
  serviceLevelGoal: number; serviceLevelThresholdSec: number; targetOccupancy: number; shrinkagePercent: number; method: 'erlang_c' | 'erlang_a'; patienceSec: number;
  blended: boolean; model: string; fteHoursWeek: number;
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
  notes: string[]; cleanedDays: number; sigmaRel: number;
};
export type AuditEntry = { at: string; by: string; role: string; action: string; reason: string | null; detail: any };
export type VersionFull = VersionMeta & { summary: { series: Series[] }; audit: AuditEntry[] };
export type DataResp = {
  version: VersionMeta; grain: string; from: string; to: string; buckets: Bucket[]; queues: { id: string; name: string; channel: string }[];
  group: { id: string; name: string; serviceLevel: number; answerSec: number; shrinkage: number; occupancyCap: number; method: string };
};
export type LeaderRow = {
  modelId: string; modelName: string; rank: number; isRecommended: boolean; wapePercent: number; mapePercent: number; mae: number; rmse: number; biasPercent: number;
  stabilityScore: 'HIGH' | 'MEDIUM' | 'VARIABLE'; stability: string; vsBaselinePercent: number; recommendationReason: string; backtestPeriod: string;
};
export type Leaderboard = { versionId: string; queueId: string | null; queueName: string; baselineWapePercent: number | null; cleanedDays: number; notes: string[]; rows: LeaderRow[]; series: { queueId: string | null; name: string }[] };

export const MODEL_LABEL: Record<string, string> = {
  auto: 'Auto (most accurate wins)', snaive: 'Same as last week', wavg: 'Weighted weekly average', ets: 'Holt-Winters (ETS)',
  gbm: 'Gradient boosting', combo: 'Ensemble (blend of models)', croston: 'Croston (sparse queues)',
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

export type Skill = { id: string; name: string; code: string; category: 'CHANNELS' | 'LANGUAGES' | 'PRODUCTS' | 'TIERS'; type: 'CORE' | 'SECONDARY' | 'SPECIALTY'; status: 'ACTIVE' | 'INACTIVE'; requiresCertification: boolean; description: string; holders: number };
export type Team = { id: string; name: string; code: string; description: string; location: string; managerId: string | null; managerName: string | null; status: 'ACTIVE' | 'INACTIVE'; memberCount: number };
export type EmployeeStatus = 'ONBOARDING' | 'ACTIVE' | 'LEAVE' | 'SUSPENDED' | 'TERMINATED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACTOR' | 'TEMPORARY';
export type Employee = {
  id: string; employeeNumber: string; firstName: string; lastName: string; name: string; email: string | null; phone: string; extension: string | null; timezone: string | null; status: EmployeeStatus; hireDate: string | null;
  teamId: string | null; teamName: string | null; location: string; employmentType: EmploymentType; weeklyContractHours: number; maxWeeklyHours: number; workDaysPerWeek: number; minRestHours: number;
  maxConsecutiveDays: number; allowWeekend: boolean; allowOvernight: boolean; nightShiftConsent: boolean; primaryGroupId: string | null; primaryGroupName: string | null; eligibleGroupIds: string[]; version: number;
  preferredTemplateId: string | null; preferredTemplateName: string | null;
  skills: { skillId: string; name: string; code: string; proficiency: number }[];
};
export type AvailabilityWindow = { id?: string; dayOfWeek: number; startTime: string; endTime: string; kind: 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED'; effectiveFrom?: string | null; effectiveTo?: string | null };
export type TimeOff = { id: string; employeeId: string; employeeName: string; type: string; startDate: string; endDate: string; days: number; status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason: string; decidedBy: string | null; decidedAt: string | null; createdAt: string };
export type ShiftTemplate = {
  id: string; name: string; code: string; description: string; status: 'ACTIVE' | 'INACTIVE'; workDays: number[]; earliestStart: string; latestStart: string; startStepMinutes: number;
  durationHours: number; paidHours: number; mealMinutes: number; breakCount: number; breakMinutes: number; flexMinutes: number; version: number;
  mealAnchorMinutes: number | null; breakAnchorMinutes: (number | null)[] | null;
};
export type SolverInfo = { status: string; gap: number; wallSec: number; variables: number; constraints: number; objective: number; candidates: number; people: number } | null;
export type ScheduleStats = {
  solver: SolverInfo; coverage: { percent: number; requiredSlots: number; underSlots: number; overSlots: number; underIntervals: number; criticalIntervals: number };
  hours: { paid: number; overtime: number; required: number; premium?: number }; shifts: number; people: number; violations: number; warnings?: number; uncoveredDays?: string[]; projectedDays?: string[];
};
export type CoverageWindow = { id: string; dayOfWeek: number; startTime: string; endTime: string; headcount: number };
export type ScheduleVersion = {
  id: string; seq: number; wfmGroupId: string; groupName?: string | null; name: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; kind?: 'DEMAND' | 'ROTATION'; coverageSource?: 'FORECAST' | 'MANUAL'; periodStart: string; periodEnd: string; forecastVersionId: string | null; forecastName: string | null;
  rev: number; hasChanges: boolean; stats: ScheduleStats; settings: any; createdBy: string | null; createdAt: string; publishedBy: string | null; publishedAt: string | null;
  violations?: Violation[];
};
export type Violation = { type: string; employeeId: string; employeeName: string; day: string; message: string; severity?: 'BLOCK' | 'WARN' };
export type ScheduleShift = {
  id: string; employeeId: string; employeeName: string; employeeNumber: string; day: string; templateId: string | null; templateName: string | null; startTime: string; endTime: string;
  startSlot: number; lengthSlots: number; overnight: boolean; source: 'SOLVER' | 'MANUAL'; activities: { type: 'MEAL' | 'BREAK'; startSlot: number; slots: number; startTime: string; endTime: string }[];
};

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const EMP_STATUS_LABEL: Record<EmployeeStatus, string> = { ONBOARDING: 'Onboarding', ACTIVE: 'Active', LEAVE: 'On leave', SUSPENDED: 'Suspended', TERMINATED: 'Terminated' };
export const TYPE_LABEL: Record<EmploymentType, string> = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contractor', TEMPORARY: 'Temporary' };
/** Monday on or after today (local), as YYYY-MM-DD: the natural start of a schedule. */
export const nextMonday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((7 - ((d.getDay() + 6) % 7)) % 7)); return fmtDate(d); };
export const dowOfDay = (s: string) => (new Date(s + 'T00:00:00').getDay() + 6) % 7;
export const slotHHMM = (s: number) => `${p2(Math.floor(s / 4) % 24)}:${p2((s % 4) * 15)}`;
export const SCHED_STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', ARCHIVED: 'Archived' };

export type Activity = { id: string; name: string; code: string; shortCode: string; category: 'WORK' | 'BREAK' | 'MEAL' | 'TRAINING' | 'MEETING' | 'COACHING' | 'ABSENCE' | 'OTHER'; countsAsWork: boolean; paid: boolean; shrinkage: boolean; ignoreAdherence: boolean; color: string; textColor: string | null; status: 'ACTIVE' | 'INACTIVE'; version: number };
export const ACTIVITY_CATEGORY_LABEL: Record<Activity['category'], string> = { WORK: 'Queue work', BREAK: 'Break', MEAL: 'Meal', TRAINING: 'Training', MEETING: 'Meeting', COACHING: 'Coaching', ABSENCE: 'Absence', OTHER: 'Other' };
export type SchedulingPolicy = { minRestHours: number | null; maxWeeklyHours: number | null; maxConsecutiveDays: number | null; maxDaysPerWeek: number | null; adherenceGraceSeconds: number; timelineColors: { shift: string; manual: string; violation: string }; weights: Record<'understaffing' | 'overstaffing' | 'contractHours' | 'preferences' | 'fairness', number>; updatedBy: string | null; updatedAt: string | null };

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
export type AttendanceDay = { employeeId: string; employeeNumber: string; name: string; day: string; scheduledHours: number; actualHours: number; varianceHours: number; status: 'MATCHED' | 'MISSED' | 'UNSCHEDULED' | 'OPEN'; punches: { clockIn: string; clockOut: string | null }[] };
export type AttendanceWeek = { employeeId: string; employeeNumber: string; name: string; weekStart: string; actualHours: number; scheduledHours: number; overtimeHours: number };
export type AttendanceSummary = { days: AttendanceDay[]; weeks: AttendanceWeek[] };
export type ImportResult = { dryRun: boolean; rowsRead: number; newPunches: number; alreadyImported: number; errors: { line: number; message: string }[]; errorCount: number; committed: boolean };

// ---------------------------------------------------------------- rotating rosters
export type RotationCrew = { name: string; offsetDays: number };
export type RotationPattern = { id: string; wfmGroupId: string; name: string; cycleDays: number; sequence: (string | null)[]; crews: RotationCrew[]; anchorDate: string; status: 'ACTIVE' | 'INACTIVE'; observesHolidays: boolean; versionId: string | null; materializedThrough: string | null; memberCount: number; version: number; createdBy: string | null; createdAt: string };
export type RotationMember = { employeeId: string; name: string; employeeNumber: string; crewName: string; effectiveFrom: string | null; effectiveTo: string | null };

// ---------------------------------------------------------------- Integration Station
export type IntegrationField = { key: string; label: string; kind: 'text' | 'password' | 'file' | 'select'; options?: string[]; help?: string; required?: boolean };
export type IntegrationPreset = { id: string; label: string; method: string; authType: string; fields: IntegrationField[]; note: string | null; writesTo: string };
export type IntegrationCatalog = Record<string, IntegrationPreset[]>;
export type Connector = {
  id: string; wfmGroupId: string | null; category: string; method: string; preset: string; name: string; status: string; config: Record<string, string>;
  lastReceivedAt: string | null; lastError: string | null; lastSample: unknown; connectedAt: string | null; backfillStatus: string; backfillThrough: string | null; hasWebhookSecret: boolean; createdBy: string | null; createdAt: string;
};
export type ConnectorCreated = Connector & { apiKey: string | null; webhookSecret: string | null; webhookUrl: string | null };
export type IntegrationFieldMap = { targetField: string; sourcePath: string; transform: string | null };
export type EntitySuggestion = { sourceId: string; sourceLabel: string; targetId: string | null; targetName: string | null; score: number };
export type EntityMatchRow = { entityType: string; sourceId: string; sourceLabel: string; targetId: string | null };

// ---------------------------------------------------------------- dynamic break re-optimization
export type BreakSuggestion = { shiftId: string; employeeName: string; type: 'MEAL' | 'BREAK'; fromSlot: number; toSlot: number; from: string; to: string; deficitReduction: number };
export type BreakSuggestions = { day: string; ready: boolean; reason?: string; nowTime?: string | null; reforecastApplied?: boolean; suggestions: BreakSuggestion[] };
