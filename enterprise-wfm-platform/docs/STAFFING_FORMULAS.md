# Staffing formulas: what we use, and the conventions behind the numbers

All the maths is in `backend/engine/staffing.py`. The default method for every group is **Erlang C**, the standard formula every Erlang calculator uses. **Erlang A** (the same model with callers
who give up) is an optional per-group setting; it is a published academic model (Garnett, Mandelbaum and Reiman, 2002), not the universal default.

## The formulas

| Quantity | Formula |
|---|---|
| Traffic (Erlangs) | `A = contacts in the interval x average handle time / interval length in seconds` |
| Chance a caller waits (Erlang C) | `Pw = (A^N / N!) x (N / (N - A)) / ( sum(k < N) A^k / k! + (A^N / N!) x (N / (N - A)) )` (computed through Erlang B, which is numerically stable) |
| Service level (Erlang C) | `SL = 1 - Pw x exp(-(N - A) x T / AHT)`, T the answer-time target |
| Average speed of answer (Erlang C) | `ASA = Pw x AHT / (N - A)` |
| Occupancy | work carried / agents. Erlang C: `A / N`. Erlang A: `A x (1 - share who gave up) / N`, because callers who left never loaded an agent |
| Agents needed | the fewest `N` meeting the service-level target, never fewer than `A / occupancy cap` |
| Scheduled people (shrinkage) | `ceil(N / (1 - shrinkage))` (not `N x (1 + shrinkage)` and not `N - shrinkage`: both understaff) |
| Chat | `AHT / (concurrency x efficiency)` into the same Erlang calculation; efficiency defaults to 0.85 and is a group setting (about 1.7 for 2 chats, 2.55 for 3) |
| Email and back office | `workload / (opening time x occupancy cap)`, workload smoothed over the turnaround window when it is longer than a day. There is no universal formula for this; it is a workload model |

Checked in `test_staffing.py` against the textbook closed forms, and in the 2026-11 review against an independent log-space implementation at 20 to 4,800 Erlangs (agent counts equal at every load), the
Call Centre Helper worked example (100 calls in 30 minutes, 180 s, 80/20: 14 agents, 88.8%; 20 scheduled at 30% shrinkage), Erlang A reducing to Erlang C as patience grows, and a call-by-call simulation.

## Conventions that differ between products (say which one a number is)

- **Service level.** Erlang C has no abandonment, so the question does not arise. With Erlang A, service level = answered within the target / **all** offered calls: callers who give up count against it
  (the conservative convention). Some platforms let you leave out short abandons (Genesys) or all abandons (Cisco), so a figure here can read lower than the same queue in another product. Not configurable yet.
- **Average wait (ASA).** With Erlang A it is the average wait of **everyone who called**, including those who gave up. Many tools report answered calls only. The screens say so next to the figure.
- **Bias.** `(forecast - actual) / actual`: positive means the forecast was too high. Some sources use the opposite sign. The screens say "over" or "under" in words.
- **Adherence.** Minutes spent doing what was scheduled / minutes scheduled, over everyone (not an average of each person's percentage).

## Deliberately not built

- **Erlang X (retrials).** A practitioner model rather than a published standard, not reliably leaner than Erlang C, and it needs a retrial rate the system does not collect.
- **Conformance** (worked time / scheduled time). Wanted mainly for attendance and payroll; to be built when asked for, and defined apart from adherence.
- **Erlang B** as a customer-facing figure (used inside Erlang C for stability only).

## Sources

Erlang C and example: Call Centre Helper, "What is an Erlang calculator"; Suptask Erlang C calculator. Erlang A and square-root staffing: Garnett, Mandelbaum, Reiman, "Designing a Call Center with Impatient
Customers" (MSOM 2002); Technion QED lecture on Erlang A. Shrinkage: Call Centre Helper, NICE CXone WFM help. Chat concurrency: Call Centre Helper, "Erlang C for chat". Service level conventions: Cisco
(document 216240), Genesys Cloud glossary. Forecast accuracy: Ding and Koole (2022) on WAPE for call centres. Most other sources found were vendor blogs; their benchmark figures are soft.
