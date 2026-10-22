/**
 * Enterprise Workforce Management (WFM) Platform - Domain Model Contracts
 * Defines multi-tenant entities, workforce, forecasting, staffing, scheduling,
 * intraday, configuration, ingestion, and audit schemas.
 */

export type TenantId = string;
export type EmployeeId = string;
export type UserId = string;
export type WFMGroupId = string;
export type TeamId = string;
export type SkillId = string;
export type QueueId = string;
export type ActivityId = string;
export type ShiftTemplateId = string;
export type ForecastId = string;
export type ForecastVersionId = string;
export type ScheduleId = string;
export type ScheduleVersionId = string;

export interface Tenant {
  id: TenantId;
  name: string;
  code: string;
  timezone: string;
  currency: string;
  activeFeatures: string[];
  createdAt: string;
}

// ---------------- WORKFORCE & EMPLOYEE ----------------
export type EmployeeStatus = 'ONBOARDING' | 'ACTIVE' | 'LEAVE' | 'SUSPENDED' | 'TERMINATED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACTOR' | 'TEMPORARY';

export interface Employee {
  id: EmployeeId;
  tenantId: TenantId;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  timezone: string;
  status: EmployeeStatus;
  hireDate: string;
  effectiveFrom: string;
  effectiveTo?: string;
  avatarUrl?: string;

  // Organization
  businessUnit: string;
  department: string;
  teamId: TeamId;
  location: string;
  managerId?: EmployeeId;
  managerName?: string;

  // Employment
  employmentType: EmploymentType;
  weeklyContractHours: number;
  minWeeklyHours: number;
  maxWeeklyHours: number;
  maxOvertimeHours: number;
  workDaysPerWeek: number;

  // WFM Assignments
  primaryWfmGroupId: WFMGroupId;
  eligibleWfmGroupIds: WFMGroupId[];
  primaryQueueId: QueueId;
  eligibleQueueIds: QueueId[];
  channels: ChannelType[];

  // Scheduling Eligibility
  schedulingStatus: 'ELIGIBLE' | 'RESTRICTED' | 'INELIGIBLE';
  eligibilityNotes?: string[];

  // Scheduling Constraints
  maxShiftLengthHours: number;
  minShiftLengthHours: number;
  minRestPeriodHours: number;
  maxConsecutiveWorkDays: number;
  maxDailyHours: number;
  allowSplitShifts: boolean;
  allowOvernightShifts: boolean;
  allowWeekendShifts: boolean;

  // Audit
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  version: number;
}

export type ChannelType = 'VOICE' | 'CHAT' | 'EMAIL' | 'BACKOFFICE';

export interface Skill {
  id: SkillId;
  tenantId: TenantId;
  name: string;
  code: string;
  category: 'CHANNELS' | 'LANGUAGES' | 'PRODUCTS' | 'TIERS';
  type: 'CORE' | 'SECONDARY' | 'SPECIALTY';
  status: 'ACTIVE' | 'INACTIVE';
  requiresCertification: boolean;
  certificationValidityDays?: number;
  description?: string;
}

export interface EmployeeSkill {
  employeeId: EmployeeId;
  skillId: SkillId;
  skillName: string;
  proficiency: 1 | 2 | 3 | 4 | 5; // 1 Beginner to 5 Expert
  effectiveFrom: string;
  effectiveTo?: string;
  certificationId?: string;
  certificationExpiry?: string;
  status: 'ACTIVE' | 'EXPIRED' | 'PENDING_RENEWAL';
}

export interface Team {
  id: TeamId;
  tenantId: TenantId;
  name: string;
  code: string;
  description: string;
  managerId: EmployeeId;
  managerName: string;
  organization: string;
  location: string;
  memberCount: number;
  status: 'ACTIVE' | 'INACTIVE';
}

export type AvailabilityType = 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED' | 'RESTRICTED';

export interface AvailabilityWindow {
  id: string;
  employeeId: EmployeeId;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 Sunday, 1 Monday, ...
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  availabilityType: AvailabilityType;
  effectiveFrom: string;
  effectiveTo?: string;
  timezone: string;
}

export type TimeOffType = 'VACATION' | 'SICK' | 'PERSONAL' | 'HOLIDAY' | 'TRAINING' | 'LEAVE' | 'OTHER';
export type TimeOffStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface TimeOff {
  id: string;
  employeeId: EmployeeId;
  type: TimeOffType;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  startTime?: string;
  endTime?: string;
  durationHours: number;
  status: TimeOffStatus;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
}

// ---------------- WFM GROUPS & WORKLOADS ----------------
export interface WFMGroup {
  id: WFMGroupId;
  tenantId: TenantId;
  name: string;
  code: string;
  description: string;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  queueIds: QueueId[];
  queueNames: string[];
  channels: ChannelType[];
  agentCount: number;
  serviceLevelGoal: number; // e.g. 80 (%)
  serviceLevelThresholdSec: number; // e.g. 20 (sec)
  targetOccupancy: number; // e.g. 85 (%)
  shrinkagePercent: number; // e.g. 22 (%)
  primaryForecastVersionId?: string;
  primaryScheduleVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Queue {
  id: QueueId;
  name: string;
  code: string;
  channel: ChannelType;
  wfmGroupId: WFMGroupId;
  slaTargetSeconds: number;
  slaTargetPercent: number;
}

// ---------------- ACTIVITIES & SHIFTS ----------------
export type ActivityClassification = 'PRODUCTIVE' | 'NON_PRODUCTIVE' | 'TIME_OFF';
export type ActivityCategory =
  | 'WORK'
  | 'BREAK'
  | 'MEAL'
  | 'TRAINING'
  | 'COACHING'
  | 'MEETING'
  | 'OFFLINE'
  | 'PTO'
  | 'SICK'
  | 'ABSENCE';

export interface ActivityDefinition {
  id: ActivityId;
  tenantId: TenantId;
  name: string;
  code: string;
  classification: ActivityClassification;
  category: ActivityCategory;
  status: 'ACTIVE' | 'INACTIVE';
  defaultDurationMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  paid: boolean;
  countsAsWork: boolean;
  deductTimeOff: boolean;
  overtimeEligible: boolean;
  adherenceEnabled: boolean;
  startToleranceMinutes: number;
  endToleranceMinutes: number;
  allowableVarianceMinutes: number;
  movable: boolean;
  resizable: boolean;
  splittable: boolean;
  crossMidnight: boolean;
  mustStayInsideShift: boolean;
  autoSchedulable: boolean;
  optimizerMovable: boolean;
  optimizationWeight: number;
  color: string;
  textColor: string;
  shortCode: string;
  icon?: string;
  version: number;
}

export interface ShiftTemplate {
  id: ShiftTemplateId;
  tenantId: TenantId;
  name: string;
  code: string;
  description: string;
  shiftType: 'FIXED' | 'DYNAMIC';
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  workDays: number[]; // [1,2,3,4,5]
  earliestStart: string; // HH:mm
  latestStart: string;   // HH:mm
  earliestEnd: string;   // HH:mm
  latestEnd: string;     // HH:mm
  durationHours: number;
  defaultActivityId: ActivityId;
  breakFlexMinutes: number;
  mealFlexMinutes: number;
  rules: ShiftActivityRule[];
  version: number;
}

export interface ShiftActivityRule {
  id: string;
  shiftTemplateId: ShiftTemplateId;
  activityId: ActivityId;
  activityName: string;
  placementMode: 'FIXED_TIME' | 'RELATIVE_OFFSET';
  fixedStart?: string; // HH:mm
  earliestOffsetMinutes?: number; // e.g. 120 min after shift start
  latestOffsetMinutes?: number;
  durationMinutes: number;
  minWorkBeforeMinutes: number;
  minWorkAfterMinutes: number;
  required: boolean;
  canMove: boolean;
  canResize: boolean;
}

// ---------------- FORECASTING & STAFFING ----------------
export type ForecastVersionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export type ForecastType = 'AI' | 'MANUAL' | 'IMPORTED' | 'ADJUSTED' | 'INTRADAY';

export interface Forecast {
  id: ForecastId;
  tenantId: TenantId;
  name: string;
  wfmGroupId: WFMGroupId;
  wfmGroupName: string;
  horizonStart: string; // YYYY-MM-DD
  horizonEnd: string;   // YYYY-MM-DD
  intervalMinutes: 15 | 30 | 60;
  activeVersionId: ForecastVersionId;
  status: ForecastVersionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ForecastVersion {
  id: ForecastVersionId;
  forecastId: ForecastId;
  versionNumber: number;
  name: string;
  type: ForecastType;
  status: ForecastVersionStatus;
  parentVersionId?: string;
  modelVersion: string;
  datasetVersion: string;
  totalVolume: number;
  averageAhtSeconds: number;
  overallWape: number;
  accuracyGrade: 'A' | 'B' | 'C' | 'D';
  createdAt: string;
  createdBy: string;
  publishedAt?: string;
  publishedBy?: string;
}

export interface ForecastInterval {
  intervalStart: string; // ISO or HH:mm
  intervalMinutes: number;
  volume: number;
  ahtSeconds: number;
  serviceGoalPercent: number;
  thresholdSeconds: number;
  confidenceLower: number;
  confidenceUpper: number;
  historicalVolume?: number;
  actualVolume?: number;
  actualAht?: number;
}

export interface ForecastAdjustment {
  id: string;
  forecastVersionId: ForecastVersionId;
  type: 'PERCENTAGE' | 'ABSOLUTE';
  metric: 'VOLUME' | 'AHT';
  scope: 'ENTIRE_HORIZON' | 'PEAK_HOURS' | 'SPECIFIC_INTERVAL';
  value: number; // e.g. +15 for 15% or +50 calls
  reason: string;
  appliedBy: string;
  appliedAt: string;
  beforeVolume: number;
  afterVolume: number;
}

export interface ForecastScenario {
  id: string;
  name: string;
  description: string;
  volumeMultiplier: number; // e.g. 1.20 for +20%
  ahtMultiplier: number;    // e.g. 1.05
  shrinkageOverride?: number;
  impactRequiredFteDelta: number;
  impactServiceLevelDelta: number;
}

export interface StaffingRequirementInterval {
  intervalStart: string;
  channel: ChannelType;
  forecastVolume: number;
  forecastAht: number;
  serviceGoal: string; // e.g. "80/20"
  targetOccupancy: number; // e.g. 0.85
  shrinkagePercent: number; // e.g. 0.22
  rawRequiredStaff: number; // Erlang C output
  netRequiredStaff: number; // After occupancy cap
  grossRequiredStaff: number; // After shrinkage scaling
  requiredFte: number;
  scheduledStaff: number;
  scheduledFte: number;
  deltaStaff: number; // scheduled - required
  coverageStatus: 'SURPLUS' | 'BALANCED' | 'UNDERSTAFFED' | 'CRITICAL';
}

// ---------------- SCHEDULING ENGINE ----------------
export type ScheduleStatus =
  | 'DRAFT'
  | 'GENERATING'
  | 'VALIDATED'
  | 'REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'LOCKED'
  | 'ARCHIVED';

export interface Schedule {
  id: ScheduleId;
  tenantId: TenantId;
  wfmGroupId: WFMGroupId;
  wfmGroupName: string;
  version: number;
  versionName: string;
  status: ScheduleStatus;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  forecastVersionId: ForecastVersionId;
  optimizerVersion: string;
  scenarioName?: string;
  totalScheduledHours: number;
  totalOvertimeHours: number;
  coveragePercent: number;
  ruleViolationsCount: number;
  skillCoveragePercent: number;
  assignedAgentCount: number;
  createdAt: string;
  createdBy: string;
  publishedAt?: string;
  publishedBy?: string;
}

export interface StaffShift {
  id: string;
  scheduleId: ScheduleId;
  employeeId: EmployeeId;
  employeeName: string;
  employeeNumber: string;
  teamName: string;
  date: string; // YYYY-MM-DD
  shiftStart: string; // HH:mm
  shiftEnd: string;   // HH:mm
  shiftDurationHours: number;
  timezone: string;
  activities: ScheduleActivity[];
  ruleIssues?: ScheduleRuleViolation[];
}

export type ActivitySource =
  | 'SHIFT_TEMPLATE'
  | 'OPTIMIZER'
  | 'MANUAL'
  | 'INTRADAY'
  | 'IMPORT'
  | 'AI_RECOMMENDATION';

export interface ScheduleActivity {
  id: string;
  shiftId: string;
  activityId: ActivityId;
  activityName: string;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  durationMinutes: number;
  source: ActivitySource;
  color: string;
  textColor: string;
  shortCode: string;
  isMovable: boolean;
  isResizable: boolean;
}

export interface ScheduleRuleViolation {
  id: string;
  code: string;
  severity: 'HARD' | 'SOFT' | 'WARNING';
  message: string;
  employeeId: EmployeeId;
  shiftId?: string;
  activityId?: string;
  suggestedFix?: string;
}

export interface SmartMoveRecommendation {
  id: string;
  startTime: string;
  endTime: string;
  coverageDelta: number;
  overtimeDeltaHours: number;
  ruleViolations: string[];
  objectiveScore: number;
  rank: number;
  recommendationTag: string;
}

// ---------------- INTRADAY & ADHERENCE ----------------
export interface IntradaySummary {
  todayDate: string;
  currentTime: string;
  wfmGroupId: WFMGroupId;
  currentCoveragePercent: number;
  currentRequiredStaff: number;
  currentScheduledStaff: number;
  currentActualStaff: number;
  currentGap: number;
  serviceLevelPercent: number;
  averageHandleTimeSeconds: number;
  occupancyPercent: number;
  adherencePercent: number;
  overtimeHoursToday: number;
  forecastAccuracyPercent: number;
  criticalIntervalsCount: number;
  agentsNearOvertimeCount: number;
}

export interface IntradayIntervalPoint {
  time: string; // HH:mm
  forecastVolume: number;
  actualVolume: number;
  forecastAht: number;
  actualAht: number;
  requiredStaff: number;
  scheduledStaff: number;
  actualStaff: number;
  gap: number;
  serviceLevel: number;
  adherenceRate: number;
}

export type AdherenceState = 'IN_ADHERENCE' | 'OUT_OF_ADHERENCE' | 'EARLY' | 'LATE' | 'UNKNOWN';

export interface AgentAdherenceRecord {
  employeeId: EmployeeId;
  employeeName: string;
  teamName: string;
  scheduledActivity: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  actualActivity: string;
  actualStartTime: string;
  startVarianceMinutes: number;
  endVarianceMinutes: number;
  durationVarianceMinutes: number;
  state: AdherenceState;
  adherencePercent: number;
}

export interface AIRecommendation {
  id: string;
  wfmGroupId: WFMGroupId;
  timestamp: string;
  intervalTarget: string; // e.g. "14:00 - 15:00"
  severity: 'CRITICAL' | 'WARNING' | 'OPTIMIZATION';
  title: string;
  problemStatement: string;
  cause: string;
  affectedQueues: string[];
  affectedEmployees: {
    employeeId: EmployeeId;
    employeeName: string;
    currentActivity: string;
    proposedActivity: string;
    currentWindow: string;
    proposedWindow: string;
  }[];
  expectedImpact: {
    coverageDeltaPercent: number;
    serviceLevelDeltaPercent: number;
    overtimeDeltaHours: number;
    ruleViolationsCount: number;
  };
  reasoningTrace: string[];
  status: 'PENDING' | 'APPLIED' | 'DISMISSED';
  canAutoApply: boolean;
}

// ---------------- CONFIGURATION & RULES ----------------
export interface SchedulingRule {
  id: string;
  tenantId: TenantId;
  name: string;
  code: string;
  category: 'REST_HOURS' | 'MAX_HOURS' | 'OVERTIME' | 'SHIFTS' | 'CONSECUTIVE_DAYS' | 'WEEKENDS';
  severity: 'HARD' | 'SOFT' | 'WARNING';
  priority: number;
  value: number | string | boolean;
  unit?: string;
  description: string;
  enabled: boolean;
  effectiveFrom: string;
}

export interface OptimizationObjectives {
  understaffingWeight: number; // 0 - 100
  overstaffingWeight: number;
  overtimeWeight: number;
  preferenceWeight: number;
  fairnessWeight: number;
  skillMismatchWeight: number;
  stabilityWeight: number;
  scheduleChangeWeight: number;
  plainLanguageExplanation: string;
}

// ---------------- IMPORT & DATA MANAGEMENT ----------------
export type ImportDataType =
  | 'EMPLOYEES'
  | 'TEAMS'
  | 'SKILLS'
  | 'AVAILABILITY'
  | 'TIME_OFF'
  | 'HISTORICAL_VOLUME'
  | 'HISTORICAL_AHT'
  | 'SCHEDULES'
  | 'ACTUALS';

export type ImportSourceType = 'CSV' | 'XLSX' | 'JSON' | 'HRIS_SYNC' | 'ACD_FEED' | 'API';

export type ImportJobStatus =
  | 'PREPARING'
  | 'UPLOADING'
  | 'MAPPING'
  | 'VALIDATING'
  | 'READY'
  | 'IMPORTING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface StagedImportJob {
  id: string;
  tenantId: TenantId;
  fileName: string;
  entityType: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdAt: string;
  createdBy: string;
}

export interface ImportJob {
  id: string;
  tenantId: TenantId;
  dataType: ImportDataType;
  sourceType: ImportSourceType;
  fileName: string;
  fileSizeKb: number;
  status: ImportJobStatus;
  totalRecords: number;
  validRecords: number;
  warningRecords: number;
  errorRecords: number;
  createdRecords: number;
  updatedRecords: number;
  skippedRecords: number;
  createdAt: string;
  createdBy: string;
  completedAt?: string;
  canRollback: boolean;
  isRolledBack?: boolean;
}

export interface ImportFieldMapping {
  sourceColumn: string;
  targetField: string;
  required: boolean;
  sampleValue: string;
  transformation?: 'TRIM' | 'UPPERCASE' | 'BOOLEAN_YN' | 'DATE_ISO';
}

export interface DataQualityIssue {
  id: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  category: 'EMPLOYEES' | 'SKILLS' | 'AVAILABILITY' | 'FORECAST' | 'SCHEDULE';
  entityId: string;
  entityName: string;
  issue: string;
  impactDescription: string;
  suggestedRemediation: string;
  createdAt: string;
}

// ---------------- AUDIT & SECURITY ----------------
export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'APPROVE'
  | 'REJECT'
  | 'PUBLISH'
  | 'IMPORT'
  | 'EXPORT'
  | 'GENERATE'
  | 'ROLLBACK';

export interface AuditRecord {
  id: string;
  tenantId: TenantId;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityName: string;
  timestamp: string;
  source: string;
  reason?: string;
  beforeSnapshot?: Record<string, any>;
  afterSnapshot?: Record<string, any>;
  diffSummary?: string;
  ipAddress: string;
}

export type RoleName =
  | 'WFM_ADMIN'
  | 'WFM_MANAGER'
  | 'FORECAST_PLANNER'
  | 'SCHEDULER'
  | 'SUPERVISOR_RTA'
  | 'ANALYST'
  | 'AGENT';

export interface UserSession {
  userId: string;
  userName: string;
  email: string;
  role: RoleName;
  tenantId: TenantId;
  tenantName: string;
  employeeId?: EmployeeId;
}
