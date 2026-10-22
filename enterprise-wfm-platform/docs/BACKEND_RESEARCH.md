# Backend research: how existing WFM products and WFM Labs build it

Purpose: decide the backend design for `enterprise-wfm-platform` (Node.js, Python, PostgreSQL, Redis, NATS, gRPC) from evidence,
not habit. Sources are listed at the end; where a vendor does not publish internals, this says so rather than guessing.

## 1. What the market products do

| Product | What is publicly known about the backend | What it implies for us |
|---|---|---|
| **Genesys Cloud WFM** | Microservices platform; WFM shares **one data model with routing**, so real-time adherence reads the routing engine natively (no polling delay). Forecasting mixes historical pattern matching, weighted averages and ML with automatic algorithm selection. Scheduling is **constraint-based optimisation** (shift rules, labour law, preferences, skills). 2,000+ REST endpoints, webhooks and event notifications. Known limits: cannot run without the host platform, weak back-office/async work, capacity planning shallower than specialists. | Adherence must be fed by an **event stream**, not batch. Support async (email/back-office) workload explicitly. Expose REST + webhooks. |
| **NICE CXone WFM** | Cloud-native on AWS, active-active across availability zones; microservices talking through an **event backbone (Kafka-class)** so events stay ordered and consumers scale independently. Forecasting: Holt-Winters, ARIMA and ML, with **hierarchical reconciliation** and an **event/holiday library**. Unified data layer with routing and quality. APIs/SDKs plus BI export (Snowflake, Redshift). Full deployments take 6-12 months (breadth cost). | Multi-method forecasting with a reconciliation step and an events library. Keep scope tight enough to ship. |
| **Amazon Connect** | ML-driven forecasting at three horizons: **long-term** (12 months, daily, refreshed weekly), **short-term** (18 weeks, 15/30-min, refreshed daily), **intraday** (refreshed every 15 min, only above a minimum volume). Forecast **groups** combine queues that share agents; schedules and capacity plans consume a **published** forecast. | Same three horizons, groups, and publish-then-consume flow (already the reference UI's model). |
| **Zoom WFM** | Public REST API around forecasts (list/get/upload forecast and staffing), **historical queue metrics import** (CSV seed), **historical agent status import** (auto-creates unknown statuses), adherence read, organisational groups. | Ingestion endpoints for interval history and agent-state events, with validation and idempotent upsert. |
| **Injixo** (via WFM Labs) | Runs **several algorithms per workload (ARIMA, neural nets, regression, proprietary) in a "forecast tournament"** and picks the best. 100+ ACD/HRIS integrations. | Model tournament per queue (what we already built). |
| **Assembled / Legion** (via WFM Labs) | API-first with native connectors; Legion **jointly optimises** demand, labour budget and preferences in one pass instead of forecast-then-schedule, and automates swaps/open-shift filling. | Keep the scheduler decoupled but let it consume demand + budget + preferences together. |
| **Calabrio / Verint / UKG** | Little public backend detail. Process pattern: clean history -> estimate volume -> arrival pattern -> finalise, with day templates, campaign % and what-if. | Process, not internals: keep the staged forecast workflow. |

## 2. What WFM Labs says (backend-relevant)

**Data model (`WFM Data Models and Schemas`).**
- Seven canonical entities: Agent, Interval, Queue, Forecast, Schedule (with ordered activities), Adherence Event, Contact.
- Model **planning and reality side by side**: Forecast(queue, interval) and Schedule(agent, interval) versus Contact(queue, interval) and AdherenceEvent(agent, interval), joined to measure accuracy and adherence.
- **15-minute interval is the standard grain** (30 minutes violates Erlang's stationarity assumption; finer adds friction). Pre-populate an interval dimension 2+ years ahead.
- Three schema shapes: **normalised OLTP** (FKs; indexes on `(agent_id, schedule_date)` and `(queue_id, interval_start)`), **star schema** for analytics, and a **denormalised `agent_current_state` row overwritten on every state change** for wallboards (a Redis-shaped problem).
- **Never overwrite forecasts; always version** ("forecast at publish time vs at execution time vs actuals" is what makes accuracy measurable).
- **Store UTC, carry the IANA zone, convert only at presentation** (DST is the classic bug).
- Data-quality rules: compare expected 96 intervals/day to actual, exclude gaps from training; cap AHT outliers at P95/P99 for forecasting but keep the raw value; reconcile terminated agents daily.
- Retention: contact detail 90 days hot; agent-state events 30 days hot then interval-aggregated; schedules current + 8 weeks ahead and 90 days back; interval aggregates 2 years at 15-min, then daily/weekly.

**Forecast methods (`Forecasting`).** Seasonal-naive baseline that every method must beat; ETS, ARIMA, regression for known drivers, STL for diagnosis, intermittent-demand methods, **forecast combination**, **hierarchical reconciliation**, probabilistic ranges, backtesting; MASE for cross-series comparison, WAPE/bias for business.

**Staffing maths (`Erlang C`).** Erlang C assumptions (Poisson, exponential service, infinite patience, single queue) fail for skill routing, concurrency, occupancy above ~93% and teams under 10-15; **Erlang A** adds abandonment; use **simulation** when routing and abandonment matter.

**Schedule optimisation (`Schedule Optimization`).**
- Decision variables: binary assign-or-not per agent/shift, plus continuous break timing.
- Hard constraints: coverage, rest periods, consecutive days, availability, mandatory patterns. Soft: labour cost, service level, preferences, fairness. Warning: a pure cost objective under-penalises service shortfall.
- Methods by scale: **MIP** to ~100k binaries (under ~200 agents, weekly batch), column generation for large flexible catalogues, **CP-SAT** for heavily structured constraints (often faster to feasibility), metaheuristics/LNS for **intraday (<30 s)**. Weekly batch window ~30 min; warm-start from the last solution.
- Track the **optimality gap**; use rolling horizons to avoid rest-period violations at week boundaries; break placement solved with the schedule, not after.

**Adherence (`Real-Time Adherence`).** Map ACD states to scheduled activities (Available/In-call/ACW all count as adherent for "working"); **tolerance windows** (login 5-15 min, break 5 min, transitions 1-2 min); adherence = share of intervals where actual matches scheduled; dashboards refresh every **30-60 s**.

**Intraday (`Intraday Management`).** Rolling reforecast; **trigger when arrivals deviate more than about 10-15% for two or more consecutive intervals** (or service level under 70% for two minutes); staffing gap from offered vs handled vs staffed; levers (overtime 15-60 min, break recall 5-15 min, cross-skill immediate, VTO 30-90 min, early departure); automate low-stakes levers, **human approval for Tier 2+** (mandatory overtime, emergency cross-skill).

**Architecture (`Technology`, `Digital Twins`).** Ecosystem of open-API components over one monolith; a Resource Optimization Center watching service level, queue depth and forecast variance; a four-layer digital twin (event ingestion -> simulation engine -> optimisation -> decision UI) with **sub-minute ACD event feeds**.

## 3. Technology evidence for our stack

| Choice | Evidence | Decision |
|---|---|---|
| **PostgreSQL + Row-Level Security** for multi-tenancy | Shared schema + RLS is the low-ops default; `FORCE ROW LEVEL SECURITY`; `tenant_id` as the **leading column** of composite indexes; test that tenant A cannot read tenant B; move big/regulated tenants to their own DB later. | Shared schema, `tenant_id` on every table, RLS enforced through a non-owner app role and a per-transaction `app.tenant_id`. |
| **Redis** | Cache role-permission maps (~10 min), short-lived aggregates, JWT denylist; prefix every key with the tenant; also the natural home for `agent_current_state`. | Tenant-prefixed keys; live agent state hash; RBAC + computed-staffing caches with TTL; rate limit; idempotency keys. |
| **NATS JetStream** vs Kafka | JetStream: sub-millisecond latency, per-message ack and redelivery, replay, **hierarchical subjects** (great for `wfm.<tenant>.adherence.*`), built-in request-reply, tiny ops footprint; Kafka wins on huge throughput and long retention (CDC, event sourcing). | NATS JetStream as the event backbone; Postgres stays the system of record; revisit Kafka only if we need multi-year replayable logs. |
| **gRPC** between Node and Python | Typed contract, streaming, language-neutral; keeps numerical code out of the API tier. | Node gateway -> Python engine over gRPC (forecast, staffing, schedule optimise/validate, intraday). |
| **Python** engine | statsmodels/scikit-learn for forecasting; **OR-Tools CP-SAT** for scheduling (constraint propagation + SAT + LP + LNS, feasible solutions in seconds, weighted-penalty objectives); numpy for Erlang. | Engine owns all maths; stateless; horizontally scalable. |
| **Node.js** gateway | I/O-bound REST + WebSocket + NATS fan-out; shares TypeScript types with the React front-end. | TypeScript gateway; thin, validating, RBAC-enforcing. |

## 4. Design rules we adopt

1. **Version everything that gets consumed** (forecasts, schedules); never overwrite; lifecycle Draft -> Submitted -> Approved -> Published -> Archived.
2. **15-minute grain, UTC storage, IANA zone on tenant/site/agent.**
3. **Planning and actuals are separate tables joined on (queue, interval) and (agent, interval).**
4. **Staged ingestion, never direct mutation from a file** (validate -> diff -> commit, with rollback); the reference UI's "Rule 7".
5. **Event-driven real time:** state events -> NATS -> adherence worker -> Redis current state + Postgres events -> WebSocket.
6. **Explainability:** every staffing number and every optimiser assignment can be traced and audited (reference "Section 43").
7. **Audit everything** with before/after snapshots, actor, role and reason.
8. **Optimiser honesty:** report status, objective, bound/gap and wall time; hard constraints are never traded away silently.

## Sources

- Genesys: [Workforce forecasting & scheduling](https://www.genesys.com/capabilities/workforce-scheduling-forecasting), [WFM overview](https://help.genesys.cloud/articles/workforce-management/), [Genesys WFM (WFM Labs)](https://wiki.wfmlabs.org/wiki/Genesys_Workforce_Management)
- NICE: [CXone open cloud architecture](https://www.nice.com/platform/cloud-architecture), [NICE CXone Platform (WFM Labs)](https://wiki.wfmlabs.org/wiki/NICE_CXone_Platform)
- Amazon Connect: [Forecasting](https://docs.aws.amazon.com/connect/latest/adminguide/forecasting.html), [ML forecasting, capacity planning, scheduling](https://aws.amazon.com/blogs/aws/amazon-connect-new-ml-powered-capabilities-for-forecasting-capacity-planning-scheduling-and-agent-empowerment)
- Zoom: [Workforce Management API](https://developers.zoom.us/docs/api/workforce-management/), [WFM core concepts](https://library.zoom.com/business-services/zoom-workforce-management/workforce-management-explainer/core-concepts)
- WFM Labs: [Data models and schemas](https://wiki.wfmlabs.org/wiki/WFM_Data_Models_and_Schemas), [Enterprise data platform](https://wiki.wfmlabs.org/wiki/Enterprise_Data_Platform), [Technology](https://wiki.wfmlabs.org/wiki/Technology), [Schedule optimization](https://wiki.wfmlabs.org/wiki/Schedule_Optimization), [Real-time adherence](https://wiki.wfmlabs.org/wiki/Real-Time_Adherence), [Intraday management](https://wiki.wfmlabs.org/wiki/Intraday_Management), [Forecasting](https://wiki.wfmlabs.org/wiki/Forecasting), [Erlang C](https://wiki.wfmlabs.org/wiki/Erlang_C), [Digital twins](https://wiki.wfmlabs.org/wiki/Workforce_Digital_Twins_and_Continuous_Planning), [Emerging platforms](https://wiki.wfmlabs.org/wiki/Emerging_WFM_Platforms)
- Optimisation: [OR-Tools employee scheduling](https://developers.google.com/optimization/scheduling/employee_scheduling), [CP-WSP CP-SAT framework](https://arxiv.org/abs/2607.05177)
- Messaging: [NATS and Kafka compared (Synadia)](https://www.synadia.com/blog/nats-and-kafka-compared), [Kafka vs Redis Streams vs NATS](https://dev.to/young_gao/real-time-event-streaming-kafka-vs-redis-streams-vs-nats-in-2026-34o1)
- Multi-tenancy: [Postgres multi-tenant architecture](https://clickhouse.com/resources/engineering/multi-tenant-saas-postgres-architecture), [RLS for multi-tenant SaaS](https://www.thenile.dev/blog/multi-tenant-rls)
