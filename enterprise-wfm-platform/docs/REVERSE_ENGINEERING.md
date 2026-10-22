# Enterprise WFM Platform: reverse-engineering report

Scope: everything under `enterprise-wfm-platform/` as delivered (an AI Studio export), analysed by reading all source and running
the app (`npm run dev`, port 3000) through every menu item. Line numbers refer to the delivered files.

## 1. What it is, in one paragraph

A **front-end-only prototype** of an enterprise workforce-management suite. It looks and reads like a finished product (9 modules,
~30 screens, a 100-section specification cited in code comments), but it has **no server, no database, no API calls and no
persistence**. Every number on screen comes from one static file (`services/wfmStore.ts`, 1,951 lines) or from small pure-TypeScript
"engines". Reloading the page discards every edit. The parts that do real computation are the **Erlang C staffing maths** and the
**forecast accuracy formulas**; nearly everything else is scripted.

| Fact | Detail |
|---|---|
| Stack | React 19, Vite 6, TypeScript 5.8, Tailwind CSS 4, lucide-react. No router, no state library, no chart library. |
| Size | About 10,000 lines in ~29 source files (largest: `wfmStore.ts` 1,951, `ScheduleTimelineView.tsx` 1,080, `WorkforceView.tsx` 629). |
| Backend | None. `express`, `dotenv`, `@google/genai`, `motion` are in `package.json` but imported nowhere. `GEMINI_API_KEY` is unused. |
| Persistence | None (no localStorage, no fetch). |
| Tests / lint | None (`npm run lint` is only `tsc --noEmit`). |
| Auth / roles | None. A role switcher exists but gates nothing (see section 9). |
| Network calls when tested | **0** across all 30 screens visited. |

## 2. Architecture

```
main.tsx -> App.tsx  (useState: activeRole, activeModule, activeSubSection, palette, traceability modal)
              |- AppHeader          tenant, WFM-group pill, Cmd+K, notifications, role switcher (mostly hard-coded text)
              |- NavigationSidebar  module + sub-item tree (Section 7 hierarchy)
              |- <one view per module>  chosen by activeModule; sub-item passed as a prop
              |- StaffingTraceabilityModal (global)  |  CommandPalette (global)
services/wfmStore.ts   static seed data (SEED_*), CURRENT_TENANT/CURRENT_USER, buildStaffingIntervals()
types/wfm.ts           domain contracts (the most valuable file, see section 4)
engine/erlangC.ts      real Erlang C solver + step-by-step derivation
engine/forecastEngine.ts  real WAPE/MAPE/MAE/RMSE/Bias formulas; leaderboard rows are hard-coded
engine/scheduleOptimizer.ts  constraint checks (real, but unused) + "smart move"/"AI repair" (hard-coded)
engine/timelineCoordinates.ts  time <-> pixel maths for the schedule timeline (real)
```

Navigation is `activeModule` + `activeSubSection` in `App.tsx`, not URLs: no deep links, no back button, nothing survives a refresh.

## 3. Module map: what each screen really does

Legend: **Real** = computed or interactive on client state. **Scripted** = animation/text written in advance. **Static** = renders seed data only.

| Module | Sub-menu | Behaviour found |
|---|---|---|
| Overview | (none) | Static dashboard, hard-coded KPIs, quick-nav tiles. |
| Workforce | Employees, Teams, Skills & Certs, Availability, Time Off | **Five different screens** (the sub-menu really switches views). Read-mostly over `SEED_EMPLOYEES`; employee form is a single-page workspace ("no wizards", Section 14). Static/local state. |
| **Forecasting** | Dashboard, Leaderboard, Builder, Adjustments, Scenarios, Accuracy Heatmap | **All six items open the same single page.** `ForecastingView` never reads its sub-section prop. Details in section 6. |
| Scheduling | Timeline, Generate, Shift Templates, Compare, Replay | Five views (real switching). Timeline = 7 hard-coded shifts. **Drag/resize is claimed in the header comment but not implemented** (only an unused `draggingActivity` state; no mouse/pointer handlers). Undo/redo works on local state. Generate = **scripted terminal** (3 `setTimeout`s printing invented solver logs: "41,200 binary variables", "MIP gap 0.08%"). Compare/Replay are static v17/v18 diffs. |
| Intraday & RTA | Live Coverage, Adherence, AI Recommendations | **Same page for all three.** Static adherence table, hard-coded recommendations; "Apply" flips a status flag. |
| Configuration | WFM Groups, Activities, Rules, Weights | Sub-menu ignored; an internal 3-tab switcher shows groups/activities/objectives. Weight sliders edit local state only. "Create WFM Group" button does nothing. |
| Data Management | Staged Ingestion, Data Quality, Scheduled Ingestion | Sub-menu ignored. A 4-step stepper (Upload -> Validate -> Diff -> Commit) driven by a **simulated upload** of a fixed file name and 4 fixed sample rows. |
| Audit & Governance | (none) | Static ledger (`SEED_AUDIT_LOGS`). |
| Security & Access | Users, RBAC Matrix | Static directory and a role x permission matrix. |

## 4. Domain model (`types/wfm.ts`, 722 lines)

Well thought out and worth reusing as the contract. Everything carries `tenantId`.

- **Workforce**: `Employee` (~50 fields incl. contract hours, rest period, max consecutive days, split/overnight/weekend flags, primary + eligible WFM groups and queues, channels, scheduling eligibility), `Skill` (category, core/secondary/specialty, certification validity), `EmployeeSkill` (proficiency 1-5, expiry), `Team`, `AvailabilityWindow` (AVAILABLE/UNAVAILABLE/PREFERRED/RESTRICTED), `TimeOff`.
- **Groups**: `WFMGroup` (queues, channels, SL goal + threshold, target occupancy, shrinkage, primary forecast + schedule version), `Queue`. Channels: `VOICE | CHAT | EMAIL | BACKOFFICE`.
- **Activities/shifts**: `ActivityDefinition` (about 30 attributes: productive class, paid, adherence tolerances, movable/resizable/splittable, optimizer weight, colour), `ShiftTemplate` + `ShiftActivityRule` (fixed-time or offset placement, work-before/after minimums).
- **Forecasting**: `Forecast`, `ForecastVersion`, `ForecastInterval`, `ForecastAdjustment`, `ForecastScenario`, `StaffingRequirementInterval`. See section 6.
- **Scheduling**: `Schedule` (status DRAFT -> GENERATING -> VALIDATED -> REVIEW -> APPROVED -> PUBLISHED -> LOCKED -> ARCHIVED, linked to a `forecastVersionId`), `StaffShift`, `ScheduleActivity` (with `source`: template/optimizer/manual/intraday/import/AI), `ScheduleRuleViolation` (HARD/SOFT/WARNING with suggested fix), `SmartMoveRecommendation`.
- **Intraday**: `IntradaySummary`, `IntradayIntervalPoint`, `AgentAdherenceRecord`, `AIRecommendation` (with reasoning trace and expected impact).
- **Config/rules**: `SchedulingRule`, `OptimizationObjectives` (8 weights).
- **Data**: `ImportJob` (9 data types, 6 source types, 10 statuses incl. rollback), `ImportFieldMapping`, `DataQualityIssue`.
- **Audit/security**: `AuditRecord` (before/after snapshots, diff summary), `RoleName` (7 roles), `UserSession`.

## 5. Engines: real versus not

| File | Verdict | Notes |
|---|---|---|
| `erlangC.ts` | **Real and correct** | Erlang C in a numerically stable recurrence; service level; incremental search for the minimum agents; **occupancy cap** applied as `ceil(A / cap)`; **shrinkage** as `ceil(net / (1 - s))` capped at 80%; ASA; a 6-step written derivation ("traceability", Section 43). Not present: Erlang A, chat concurrency, async (email) workload, multi-skill pooling. |
| `forecastEngine.ts` | **Half real** | WAPE, MAPE, MAE, RMSE, Bias are correct textbook formulas but **nothing calls them**. `getModelLeaderboard()` returns 5 hard-coded rows (5.8% WAPE "Auto Ensemble (Prophet + XGBoost + ETS)", etc.). `applyForecastAdjustment()` is correct (percent or absolute, optional interval filter, +/-8% band) but the page re-implements it inline. **No forecasting model exists**: no ETS, ARIMA, XGBoost or Prophet code. |
| `scheduleOptimizer.ts` | **Mostly scripted** | `validateShiftConstraints` (max daily hours, availability window, mandatory meal over 6h, activity overlap) is real logic, but **is imported and never called**. `calculateSmartMoveAlternatives` uses fixed candidate times and a fake `coverageDelta` (+3 or -2 by clock window). `explainEmployeeSchedule` returns fixed sentences. `generateScheduleRepairRecommendations` returns the same three named employees (Jane Doe, Arun Patel, Priya Sharma) and fixed impact numbers. `normalizeEmployeeToWorker` hard-codes skills and availability. |
| `timelineCoordinates.ts` | **Real** | Zoom levels 15m/30m/1h/2h, px-per-hour, snap, time <-> pixel conversion. Powers the timeline and heatmap alignment. |

## 6. Forecasting: the part we are building on

**Intended sequence** (sidebar order = spec order, Sections 31-40): 1 Forecast Dashboard -> 2 Model Leaderboard (Section 37) ->
3 Forecast Builder -> 4 Adjustments -> 5 Scenarios -> 6 Accuracy Heatmap (Section 40). Section 43 (staffing traceability) hangs off any
staffing number.

**Lifecycle** (`ForecastVersionStatus`): `DRAFT -> SUBMITTED -> APPROVED -> PUBLISHED -> ARCHIVED`.
Version types: `AI | MANUAL | IMPORTED | ADJUSTED | INTRADAY`. A version records model version, dataset version, total volume,
average AHT, overall WAPE, accuracy grade A-D, creator and publisher.

**What the single page actually shows** (`ForecastingView.tsx`, 488 lines):

1. Header + scenario switch (Baseline / +20% volume / AHT +15%) + "Apply Adjustment".
2. Four KPI cards. **Hard-coded**: "+4.2% vs Last Tuesday", "418s", "94.2% (5.8% WAPE)", "Grade A", "peak at 14:00".
3. Demand curve: 14 hourly CSS bars for a single day, forecast vs actual, with a faint "confidence band" that is just the bar height + 12%. Metric toggle: volume / AHT / Erlang-C staff (this one is computed live).
4. Model leaderboard: the 5 hard-coded rows. "Deploy Model" buttons do nothing.
5. Accuracy heatmap: **a fixed grid of typed-in percentages** (9 intervals x 5 weekdays) with emoji dots.
6. Adjustment dialog: percentage or absolute, with a mandatory-looking reason field that is never validated or recorded. Applies to local state only.
7. Clicking a bar opens the traceability modal (real Erlang derivation, fixed targets 80/20, 85%, 22%).

**Missing entirely** although the menu promises them: a Forecast Builder (no screen), Scenarios as a screen (three buttons only),
version list / lifecycle / approval UI, multi-day and 15-minute views, per-queue or per-channel forecasts, long-term capacity planning,
adjustment audit trail, and any connection between the forecast and the schedule beyond a shared seed array.

## 7. Data ingestion (Sections 76-80, "Rule 7")

Principle stated in code: **no direct database mutation from a file upload**. Intended 5-stage pipeline: Upload -> Parse/validate ->
Diff inspection -> Pre-flight quality audit -> Atomic commit, with rollback and 9 data types (employees, teams, skills, availability,
time off, historical volume, historical AHT, schedules, actuals). Implemented: the stepper UI and a simulated file. Nothing parses,
validates or commits.

## 8. Design system (locked; keep it)

Tailwind utilities with literal hex values, small type, restrained shadows.

- **Ink / greys**: `#171717` text, `#525252` secondary, `#737373` muted, `#A3A3A3` disabled. **Surfaces**: `#FFFFFF`, `#FAFAF8`, `#F5F5F2`. **Borders**: `#E5E5E0`, strong `#D6D6D0`.
- **Status**: success `#2F7D5A` on `#EAF5EF`; warning `#B7791F` on `#FFF5DD`; critical `#C84A4A` on `#FCEBEC`; info `#4F6F8F` on `#EDF3F8`.
- **Type**: system/Inter stack; 22px page titles, 16px card titles, 13px body, 11-12px labels in uppercase tracking; numbers in monospace with tabular figures.
- **Patterns**: header (56px) + 240px sidebar with expandable groups + scrolling workspace; cards = 1px border, 8px radius, `shadow-xs`; pills for status; segmented controls for view switches; 6px custom scrollbars; modals with 40% black backdrop.
- **Activity colours** (schedule): work green, break amber, meal slate-blue, training purple, coaching teal.

## 9. Defects and inconsistencies found

1. **Sub-menu is decorative** for Forecasting (6 items -> 1 page), Intraday (3 -> 1), Configuration (4 -> 1 with internal tabs), Data Management (3 -> 1).
2. **Crash**: clicking any notification in the bell throws `onNavigate is not a function`. `AppHeader` requires `onNavigate`, `searchQuery`, `onSearchChange`; `App` never passes them (TypeScript does not flag it under this config).
3. **Role switcher gates nothing.** `activeRole` is passed around and never read to hide or disable anything; the RBAC matrix is documentation only.
4. **Header/data mismatch**: "Billing Support (122 Agents)" and "Draft v18" are typed strings; the roster shows **7** employees and the forecast covers **one day**.
5. **Unused code**: `validateShiftConstraints`, the metric functions, `applyForecastAdjustment`, the Gemini/Express dependencies.
6. **Fake progress**: schedule generation and data import are timed animations with invented figures; "Applied" recommendations only change a label.
7. **Time zones**: shifts and forecasts carry "HH:mm" strings and a tenant time zone but nothing converts or validates them.
8. **No error/empty/loading states** anywhere (there is nothing asynchronous).
9. **Accessibility**: clickable `div`s without roles/keyboard support; colour-only status in places (emoji dots).

## 10. Spec coverage map (from comments in code)

| Sections | Topic | Where | State |
|---|---|---|---|
| 7 | Navigation hierarchy | `NavigationSidebar` | Built (partly decorative) |
| 14-18 | Employee, teams, skills, availability, time off | `workforce/*` | Static screens |
| 21-30 | Time-off workflow, holidays, accruals | `TimeOffView` | Static |
| 31-40 | Forecasting | `ForecastingView` | One page; leaderboard/heatmap hard-coded |
| 43 | Staffing traceability | `StaffingTraceabilityModal`, `erlangC.ts` | **Real** |
| 51-64 | Timeline, heatmap, drag/resize, smart move, AI repair, compare, replay | `scheduling/*` | Layout real; drag/resize absent; AI parts scripted |
| 58 | Schedule generation wizard / solver diagnostics | `ScheduleGeneratorModal` | Simulated |
| 59-60 | Shift templates | `ShiftTemplatesView` | Static + local form |
| 65-69 | Intraday, adherence, AI recommendations | `IntradayView` | Static |
| 71-75 | Configuration, audit | `ConfigurationView`, `AuditView` | Static |
| 76-80 | Staged ingestion, data quality | `DataManagementView` | Simulated |
| 81-100 | Users, RBAC, tenant isolation | `UsersAndRolesView` | Static; no enforcement |

## 11. What this means for building it for real

The prototype is a **specification-quality UI**, not a working system. To make the forecasting path real, the missing pieces, in
the prototype's own sequence, are:

1. **Data first**: real queues/WFM groups and interval history (import with validate -> diff -> commit, as Rule 7 requires).
2. **Dashboard**: multi-day, 15-minute forecasts with a genuine likely range and the agents each interval needs.
3. **Leaderboard**: actually run candidate models on a rolling backtest and rank them (WAPE, MAPE, MAE, RMSE, bias, stability).
4. **Builder**: create a versioned forecast from history and events, with an Erlang capacity preview.
5. **Adjustments**: percent/absolute overrides with a **mandatory reason**, an audit trail, and lock on submit.
6. **Scenarios**: named volume/AHT/target what-ifs compared against the baseline.
7. **Accuracy heatmap**: computed from forecast vs actual by day and hour.
8. **Lifecycle**: Draft -> Submitted -> Approved -> Published -> Archived, with the published version feeding scheduling.
9. Cross-cutting: authentication and the seven roles enforced server-side, tenant isolation, audit records with before/after
   snapshots, and persistence.

Reusable as-is: the domain types, the Erlang solver and derivation, the metric formulas, the timeline geometry, the design system.
Not reusable as functionality: the leaderboard/heatmap/KPI values, the optimizer "AI" outputs, the generation and import simulations.
