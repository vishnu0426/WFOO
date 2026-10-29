# Scenario check: 24x7 voice centre, 20,000 calls/day, 3-minute AHT, 355 people, 1-7 Nov 2026

Reproduce (in `backend/engine/scenarios/call_centre_24x7`): `python step1.py`, `python step2.py 0.30`, `python step3.py 120 6 6`.
The history is synthetic (120 days, about 20,000 calls/day, weekday and intraday shape, 3.5% daily noise, 6% interval noise) so the forecast can be scored against a known truth.

## 1. Forecast (Sun 1 Nov to Sat 7 Nov)
* Model chosen by the backtest: weekday average (WAPE 3.3%, beats seasonal naive at 4.6%).
* Sun 1 Nov: 19,207 forecast vs 19,477 expected (-1.4%). Sat 7 Nov: 18,898 vs 18,691 (+1.1%). Weekdays 20,600-21,800.
* Against one noisy simulated "actual" week: 7-day WAPE 3.9%, 15-minute interval WAPE 6.2%. This is mostly the noise put into the data.
* Limit: the backtest uses a 7-day horizon, so accuracy further out is not measured.

## 2. Staffing (Erlang C, 80% in 20 s, occupancy cap 85%, 30% shrinkage)
* 3-minute AHT makes the workload about 42 phones on average. People on the schedule: about 75 on average, peak 159 at 10-11 am, quietest 10 at night.
* The week needs 12,472 person-hours. 355 people x 40 h = 14,200 h, so contract hours exceed demand by 14%. That surplus is unavoidable if everyone must get 40 h.

## 3. Schedule for 355 people, solver limit 120 s
* Hourly starts at any time of day (nights included), 8.5 h shifts with a 30-minute unpaid meal, rest 11 h, at most 6 days in a row, 5 days a week.
* **Before this change:** weeks were fixed Monday to Sunday, so 1-7 Nov (Sun to Sat) was split into a 1-day and a 6-day week. Result: 234 people got 40 h, 60 got 32 h, 61 got 48 h.
* **After (new "Pay week starts on" setting, Sunday):** all 355 people get exactly 40.0 h. No rest or days-in-a-row violations (checked independently of the model).
* Coverage 99.7% of the required person-hours (40 h short out of 12,472, worst single 15-minute slot short by 18 people on Sunday), 2,646 surplus hours. Status FEASIBLE (not proven optimal, gap about 32%).
