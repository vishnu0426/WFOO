# 04 — Synthetic data specification

Generator: `05-synthetic-data-generator/generate.py` (Python 3.12 + numpy). Deterministic: same `--seed` + arguments ⇒ byte-identical files (checked by hashing two runs).

## Identity and traceability
* `TEST_RUN_ID` = `TR<seed>E<employees>` (or `--run-id`). Every employee number, team, group, queue, site and skill name starts with `<TEST_RUN_ID>-`.
* `employees_ext.csv` and `manifest.json` carry `TEST_RUN_ID, TEST_DATA_FLAG=TRUE, CREATED_BY_TEST_RUN, CREATED_AT`.
* Emails use the reserved domain `wfm-test.example`; names come from a fixed synthetic list. No real personal data.
* The app's import has no column for the tag fields, so on the server side records are traced by the name/number prefix **plus** the manifest's exact lists. Cleanup never matches on prefix alone (see below).

## Shape of the organisation
* ~1 WFM group per 2,000 people (50 people → 1 group, 200k → 100 groups), channel mix VOICE, VOICE, CHAT, EMAIL, BACKOFFICE, spread over 5 sites in 5 time zones (Kolkata, Manila, London, New York, Mexico City).
* Teams of 15; the first person of each team is marked supervisor.
* 22 % part-time (20/24/30 h, ≤ 8 h a day), the rest 37.5–40 h with max weekly hours +8 (cap 48). Days per week always enough to fit the contract (checked).
* Skills: the group's channel (level 2–5), a language (70 % English), and 25 % have a second channel.
* Hire dates 30 days–10 years back (seniority for bids/VTO); 1 % inactive; 2 % flagged for a portal login.

## Demand history
* 90 days history + 28 days holdout ("future actuals"), 15/30/60-minute intervals.
* Per channel: own AHT, talk/hold/ACW split, intraday peaks, weekend factor, open hours, abandon rate (voice 6 %, chat 3 %, email/back office 0).
* Weekday pattern, 0.15 %/day trend, quarterly seasonality ±8 %, holidays at 40 %, random spike days (+60 % volume, +50 % abandons).
* Volume is sized so the workload needs roughly the group's headcount (36 h × 70 % availability × 80 % occupancy).
* Poisson arrivals around a known mean → `truth_*.csv` holds the noise-free mean per interval, so forecast accuracy is measured against a known answer as well as against the noisy holdout.
* Identities enforced: `offered = handled + abandoned`; `AHT = (talk + hold + ACW) / handled`.

## Data-quality checks (quality.json)
Duplicate numbers · team/group/skill references · weekly ≤ max weekly · weekly ≤ days × daily max · run-ID prefix · offered/handled identity · AHT identity. A failed check stops the run. (It already caught one generator bug: part-timers with 30 h over 3 days of 8 h. Fixed.)

## Measured sizes
| Employees | Groups | Teams | History rows (15-min) | Files | Time |
|---:|---:|---:|---:|---:|---:|
| 50 | 1 | 4 | 5,400 | 0.9 MB | <1 s |
| 5,000 | 2 | 334 | 10,800 | 3.5 MB | 1 s |
| 200,000 | 100 | 13,400 | 548,800 | 162 MB | 32 s |

## Loading and cleanup
* Loaded through the app only: setup (sites, skills, groups, teams) via API, employees via the CSV import (dry run, then commit), history via ingestion.
* Preferred environment: a throwaway database per stage (`wfm_audit_<RUN>`) → cleanup is dropping that database after the report is saved.
* On a shared server: cleanup works from `manifest.json` + the IDs the app returned at creation (recorded in `18-test-data-manifest.json`), dry run listing every record first, **your explicit approval**, then deletes in FK order inside a transaction. No broad DELETE/TRUNCATE, no date- or prefix-only matching.

## Generator v2 — `gen.cjs` (from stage 500 on)
* Same demand model, written in plain JavaScript with its own seeded PRNG, so the **same function runs in Node (answer key on disk) and inside the signed-in page (data sent to the app)**. Checked per run: FNV-1a checksum + length of every CSV is identical on both sides (stage 500: employees `49dee5dc:79259`, five history files equal).
* `--groups N` forces the channel mix early (stage 500: 5 groups × 100 — voice Kolkata, voice Manila, chat London, email New York, back office Mexico City).
* Status for the 1 % non-active people is `SUSPENDED` (the app's statuses are ONBOARDING / ACTIVE / LEAVE / SUSPENDED / TERMINATED; `INACTIVE` was my mistake and was refused by the import's dry run).
* History AHT is left blank when nothing was handled (the app rejects AHT 0 — AUD-05).
