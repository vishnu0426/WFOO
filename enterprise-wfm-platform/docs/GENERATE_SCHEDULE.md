# Generate Schedule: checks that offer the fix

The "Ready to generate?" checklist used to say what was wrong and stop there. Now each failed check carries the button that puts it right.

## What a failed forecast check offers

Rules live in `src/services/generateFixes.ts` (no React, unit-tested in `backend/gateway/test/generateFixes.test.ts`).

| Situation | Message | Button |
|---|---|---|
| A published short-term forecast covers any of the dates | Forecast: name (OK) | none |
| The published forecast starts after the chosen dates | "The published forecast covers 3 Jan 2027 to 30 Jan 2027, not 8 Nov 2026 to 14 Nov 2026" | **Start on 3 Jan 2027** (first pay-week day it covers) |
| A draft / submitted / approved forecast covers the dates | "Forecast v5 covers these dates but is still a draft" (or "waiting for approval", "approved but not published") | **Open forecast v5 to publish it** (goes to Forecasts) |
| The published forecast has ended, or none exists | "The published forecast ended on …" / "No published short-term forecast" | **Build a forecast for these dates** (needs forecast:create) |
| Any of the above and the group has coverage windows | | **Use manual coverage windows** (secondary) |

"No staffing target for N days" gets the same Start / Build button. When Generate is off, the line "Generate is off: <first failing check>" sits above the button.

## Template labels

Start windows were read as shift hours. Everywhere a template is named in a list: `Day shift · starts 06:00–09:00 · 8.5h` (single time when fixed). The template picker column reads "starts 07:00 to 13:00"; the Templates table "starts 06:00–09:00 every 60m".

## Estimated solver time

For every build the checklist shows: "Takes up to about 1 min 20 s for 30 people: the search stops at 60 s per four-week window, sooner if it has a good roster. It can be changed under Advanced." It is the most the solver is allowed (from the readiness estimate), not a promise.

## Too many people for the work (added 2026-11-13)

A real build of 355 full-time people had 14,200 contract hours against about 9,000 hours of demand, and the result screen said "97% covered" in green and "Good solution" while its own banner said the roster was only the starting one. Changed:

- **Before the build**, the checklist shows an amber caution (it does not block): "Contracts give 14,200 h but the forecast needs about 8,983 h: about 37% of the paid time has no demand behind it. About 225 of these 355 people would cover it, so not everyone can reach their full contract without being overstaffed." It shows when contracts are 25% or more above the need, with a button **Lower "Meet contract hours"** (sets the weight to 40). Rule: `crewNote` in `generateFixes.ts`, the same 25% threshold as the after-build note.
- **Result tiles** use the Forecast Dashboard tile. "Forecast covered" turns amber with "Overstaffed: 45% more paid time than needed" when paid time is 15% or more over the need. "Paid hours" says how many hours the forecast needed.
- **Solver tile** says "Starting roster only / Nothing better found in the time given" (and, in the report, that it may already be close to the best) when the report has the STARTING_ROSTER warning, instead of "Good solution, within 0.0% of best".

**Why the roster was not tuned (measured, `qa/solver-experiment.mjs`, 355 people, one week, test stack; corrected 2026-11-13).** The first measurement was misleading: the engine called an answer "starting roster only" whenever the solver could not prove how close it was to the best (a gap of 100% or more), even if it had improved on the start. The engine now compares the solver's roster with the starting roster and only says so when it is no better (`_beats_start` in backends.py; test in `test_backend_parity.py`). With that fixed: 12 start times (19,880 shift choices) at 60 s: tuned, finished in 35 s (it used to take 65 s because backups were run needlessly); 24 start times (39,760 choices) at 60 s: truly the starting roster, and 120 s gave the identical roster. So the limit for a 355-person group lies between about 20,000 and 40,000 shift choices, and more time does not move it. The checklist now warns before the build above 45,000 (estimate: people x days x start times; `optionsNote`), and the engine's advice text says the same. The limit was found on one kind of group (flat coverage windows, fixed start times); a different group may differ. Making the solver itself cope with more choices is engine work, not done.

Not done: activities or VTO for the surplus; a button that picks which people to leave out; the old uppercase tiles remain on Schedule Quality compare, Payroll and other screens.

## Verified

- 16 unit tests (fix choice, pay-week rounding, drafts, archived/long-term ignored, labels, durations).
- 20 unit tests in total (the last four cover the crew note, overstaffing percent and solver headline).
- `qa/generate-check.mjs`, now 27 browser checks (the 19 below plus the surplus warning, the Lower button, the result tiles built through the UI) at 1280 px against a test stack: start-later fix moves the date and enables Generate; draft fix names the version and opens Forecasts; no-forecast group shows Build and manual windows; template picker wording; solver-time line; axe and console clean.

Not verified: a real build run after using each fix (the fixes only change the inputs); the Build button's destination was not clicked through to the Builder.
