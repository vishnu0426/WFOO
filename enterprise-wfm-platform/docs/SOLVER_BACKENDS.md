# Solvers, backups and scale-out

## One model, several solvers

CP-SAT (OR-Tools) is the primary solver. The same rules and the same objective are also written once as a mixed-integer program (`backend/engine/backends.py`, `build_lp`) and handed to **HiGHS** or **SCIP**, so a backup answers the same question and obeys the same hard rules. The greedy starting roster is the last resort: it always exists and always obeys the hard rules.

Default order: `cpsat, highs, scip, greedy` (with `timefold` before `greedy` when `TIMEFOLD_URL` is set, never first) (`SOLVER_CHAIN` in the engine's environment, or the request's `solver`, or "Solver" under Advanced on Generate Schedule).

A solver is abandoned when it raises an error, returns nothing, or only hands back the greedy starting roster; the next is tried and the best answer seen wins. "Infeasible" is reported as infeasible rather than passed on to another solver, because the rules are the same for all of them. Every attempt is recorded (`stats.solver.attempts`), the answer says which solver produced it (`stats.solver.backend`), and the Generate screen shows a banner when a backup built the schedule. A fallback is never silent.

What the MIP covers: one shift a day, rest between shifts, days in a row (including what carries over), weekly hours and days, the contract-hours target, coverage per slot (and per skill), surplus beyond need, same start/end times (prefer and require), preferences, weekend fairness and carry-over, and time spent past the end of the period. Tests (`engine/test_backends.py`) check every backend's answer against an independent rule checker and that HiGHS and SCIP reach the same objective as each other on a small problem.

## Licences and what is installed

Only open-source solvers are used. Nothing here needs a licence or a licence key.

| Solver | Licence | Status in this build |
|---|---|---|
| CP-SAT (OR-Tools) | Apache 2.0 | Always available. Primary. |
| HiGHS | MIT | Ships inside SciPy. First backup. Slower than CP-SAT on large crews and has no warm start here. |
| SCIP | Apache 2.0 | Ships inside OR-Tools. Second backup, a different algorithm from HiGHS, so a problem one struggles with may suit the other. Gets the greedy roster as its starting hint. |
| Greedy roster | n/a | The starting roster, always obeys the hard rules. Last resort. |
| Timefold | Apache 2.0 (Community Edition only) | **A separate Java service** (`backend/timefold-service`, `docker/Dockerfile.timefold`): Timefold is a Java library with no Python package, so it cannot run inside the engine. It is off until `TIMEFOLD_URL` is set and is never in the default chain; ask for it with the request's solver (`timefold`) or add it to `SOLVER_CHAIN`. It implements most but not all rules (below), is used only for requests whose rules it declares, and its answers are validated like every other solver's. |

## Scale-out

- **Several engines.** `ENGINE_ADDR` accepts a comma-separated list (`127.0.0.1:50051,10.0.0.5:50051`). The gateway sends each call to the least busy engine and skips one that is down for 15 seconds; a call that finds the first engine unreachable is tried on the next. Verified by running two engines and stopping one.
- **Several gateways.** Jobs are claimed with `FOR UPDATE SKIP LOCKED`; webhook events are taken by one gateway through a shared JetStream consumer. `SCHEDULE_JOB_CONCURRENCY` (default 2) is how many builds one gateway runs at once.
- **A very large group is split.** Past about 120,000 candidate shifts one solve is not practical, so the people are split into parts (by team where possible), each part gets its exact share of the demand in every quarter-hour, and the parts are solved side by side on the engines. Groups of 2,000 and 4,000 people were run this way (`SCALE_BENCHMARK.md`).
- **Partitioning is by WFM group.** Groups are independent, so many groups build in parallel across engines. Inside one group, windows run one after another because each starts from the one before.
- **Memory.** Every CP-SAT worker holds a copy of the model; past about 70,000 candidate shifts the engine uses fewer workers, and a request over 300,000 is refused. A 355-person 24x7 group works (see `SCENARIO_24x7_355.md`); groups of 500 to 4,000 people were benchmarked (`SCALE_BENCHMARK.md`).

"Billions of people" is not a real scheduling problem; the biggest employers have a few million, and nobody schedules them as one model. What matters is that many independent groups build in parallel, which this does.

## The stress test

`engine/simulation.py` plays random call arrivals against a schedule: Poisson arrivals at the forecast's rate, scaled for the whole stretch by one random forecast error, exponential handling times and patience, a single first-come queue, and staffing that changes at each 15-minute edge (those already on a call finish it). It reports the share answered in time, the 10th percentile ("a poor day"), abandonment, occupancy and the chance each day meets its target. It agrees with Erlang A within about 2 points of service level and 0.2 points of abandonment in steady state (`test_simulation.py`). People on the phones are everyone on shift less planned meals and breaks, less an absence allowance you choose.

## Timefold service

Build: `mvn package` in `backend/timefold-service` (Java 21; or `docker build -f docker/Dockerfile.timefold .`). Run: `java -jar target/timefold-service.jar` with `PORT` (8090), `BIND` (127.0.0.1), `TIMEFOLD_TOKEN` (when set, every
request must carry it in `X-Token`; set it whenever the port is reachable by anyone else), `TIMEFOLD_MAX_BODY_MB` (256), `TIMEFOLD_MAX_SOLVES` (1; a second solve gets 503 and the engine moves on). In the engine set `TIMEFOLD_URL` and the same `TIMEFOLD_TOKEN`.

How it works: the engine compiles the problem once (`backends.timefold_problem`, from the same `build_lp` that feeds HiGHS and SCIP, so the hard limits cannot drift apart): every upper limit over shift choices
(one shift a day, rest, days in a row, hours and days in a week, with history and hours worked elsewhere), per-slot need, each person's contract and overtime goals, the weekend and holiday spread, per-shift costs. The service
searches with Timefold's constraint streams (construction heuristic, then local search from the greedy roster) and answers the chosen shifts. It reports FEASIBLE or UNKNOWN, never OPTIMAL (local search proves nothing).
Then the engine runs its validator and the shared scorer on the roster; a roster that breaks a rule is rejected and the next solver is tried.

| Rule | Timefold |
|---|---|
| one shift a day, rest (clock changes, other groups, history), days in a row, weekly hours and days | yes (compiled limits) |
| cover per slot, meals and split-shift gaps, repeating period, surplus, large surplus | yes |
| per-shift costs, preferences, time past the end | yes |
| contract hours, planned overtime | yes |
| weekend and holiday fairness | yes |
| required usual start and end | yes (pairwise: starts and ends within twice the tolerance) |
| **skill-based demand** | **no**: the engine never sends it such a request |
| **preferred usual start and end** | **no** |

Open-source check: the dependency tree (`docs/sbom/timefold.cdx.json`) is Timefold Solver Core (Apache 2.0), Jackson (Apache 2.0), SLF4J (MIT), Micrometer (Apache 2.0), JAXB runtime (EDL/BSD), Commons Math (Apache 2.0). No
Enterprise Edition artifact. Tests: `engine/test_timefold.py` starts the real service and runs it through the engine (set `TIMEFOLD_JAVA_HOME` to a JDK 21 when Java is not on the path; skipped, with the reason, when there is no Java or no jar).
Limits: the pairwise consistency rule and the per-slot terms make memory grow with the options per person and the options in all; it was run on 10 people for 7 and 14 days, not at the scale CP-SAT is.
