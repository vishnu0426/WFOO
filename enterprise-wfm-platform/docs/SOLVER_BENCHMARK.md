# Scheduling solver benchmark

## Update, 2026-10-28: a better starting roster

The tables below were measured before the solver's starting roster was rebuilt and before a missing starting value was added for the weekend-fairness variable (see SCHEDULE_QUALITY.md, section 12). The same run, same machine, same settings (7 days, 60 s, same start and end time off) now gives:

| Agents | Candidate shifts | Result | Time (s) | Shifts | People used | Requirement covered | Model variables |
|---:|---:|---|---:|---:|---:|---:|---:|
| 50 | 2,800 | FEASIBLE | 61.5 | 250 | 50 | 98.4% | 3,836 |
| 100 | 5,600 | FEASIBLE | 64.0 | 500 | 100 | 98.1% | 6,710 |
| 250 | 14,000 | FEASIBLE | 71.0 | 1,250 | 250 | 97.9% | 15,260 |
| 500 | 28,000 | FEASIBLE | 75.8 | 2,500 | 500 | 97.9% | 29,510 |
| 1000 | 56,000 | FEASIBLE | 85.0 | 5,000 | 1000 | 97.9% | 58,010 |

Up to 250 agents nothing changed. At 500 and 1,000 agents coverage rose from about 92% to about 98%, because the solver can now start from a full roster instead of having to find one. Still every run uses the whole time limit and returns FEASIBLE, never proven OPTIMAL. The older tables follow for comparison; they were not re-run.

---

Machine: Intel64 Family 6 Model 142 Stepping 12, GenuineIntel · 8 logical CPUs · Python 3.12.10 · OR-Tools CP-SAT

Settings: 7 days, solver limit 60 s, same start and end time: off. Synthetic crews of 40-hour, five-day agents; three shift shapes; demand sized to 55% of the crew.

| Agents | Candidate shifts | Result | Time (s) | Shifts | People used | Requirement covered | Model variables |
|---:|---:|---|---:|---:|---:|---:|---:|
| 50 | 2,800 | FEASIBLE | 61.4 | 250 | 50 | 98.4% | 3,836 |
| 100 | 5,600 | FEASIBLE | 62.5 | 495 | 100 | 98.1% | 6,710 |
| 250 | 14,000 | FEASIBLE | 65.1 | 1,250 | 250 | 97.8% | 15,260 |
| 500 | 28,000 | FEASIBLE | 69.1 | 2,284 | 500 | 92.0% | 29,510 |
| 1000 | 56,000 | FEASIBLE | 78.4 | 4,574 | 1000 | 91.8% | 58,010 |

Result: OPTIMAL is proven best; FEASIBLE is a good schedule found inside the time limit; UNKNOWN means nothing was found in time.

## Same start and end time required

Settings: 7 days, solver limit 60 s, same start and end time: require. Synthetic crews of 40-hour, five-day agents; three shift shapes; demand sized to 55% of the crew.

| Agents | Candidate shifts | Result | Time (s) | Shifts | People used | Requirement covered | Model variables |
|---:|---:|---|---:|---:|---:|---:|---:|
| 50 | 2,800 | FEASIBLE | 61.5 | 249 | 50 | 97.8% | 4,636 |
| 100 | 5,600 | FEASIBLE | 63.3 | 498 | 100 | 97.7% | 8,310 |
| 250 | 14,000 | FEASIBLE | 66.4 | 1,167 | 250 | 95.0% | 19,260 |
| 500 | 28,000 | FEASIBLE | 74.4 | 2,315 | 500 | 93.1% | 37,510 |

Result: OPTIMAL is proven best; FEASIBLE is a good schedule found inside the time limit; UNKNOWN means nothing was found in time.

## How to read this

* Every run used the whole 60-second limit, so every result is **FEASIBLE** (a good schedule found in time), never **OPTIMAL** (proven best). Longer limits will cover more.
* Wall time is the limit plus the time to build the model, which grows with the crew: about 1.5 s at 50 agents, about 18 s at 1,000.
* Requirement covered falls from about 98% (50-250 agents) to about 92% (500-1,000 agents) at a 60-second limit: the solver has less time per agent. This is a measure of the limit, not of what the model can reach.
* Requiring the same start and end time cost between 0.4 and 2.8 points of coverage at 50-250 agents. At 500 agents the required run scored higher than the free one, which only shows the results are within the noise of a time-limited search. One run per size, on one machine: treat it as an order of magnitude.
* The demand here is synthetic and gentle (shapes repeat every weekday), with no availability, time off or skills. A real crew will be harder.
* Reproduce with `python bench_scheduling.py 50 100 250 500 1000 --limit 60` in `backend/engine`.
