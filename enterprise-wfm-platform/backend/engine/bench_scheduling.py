"""Scheduling solver benchmark: how the production path (solve_period) behaves as the crew grows.

    python bench_scheduling.py                    # 50, 100, 250, 500, 1000 agents, one week, 60 s each
    python bench_scheduling.py 500 1000 --days 14 --limit 90 --consistency require --out ../../docs/SOLVER_BENCHMARK.md

Each run builds a synthetic week for N agents who all have 40 contract hours, five days a week, and three shift shapes (early, day, late), against a demand curve
sized to the crew. It reports whether the solver finished, how long it took, how much of the requirement is covered and how large the model was. The numbers are
for the machine it ran on (printed at the top), so compare runs on the same machine.
"""
import argparse
import os
import platform
import time

import scheduling
import wfm_pb2

SPD = 96
CURVE = [0, 0, 0, 0, 1, 2, 4, 8, 12, 15, 16, 15, 12, 13, 15, 14, 12, 10, 7, 4, 2, 1, 0, 0]  # people needed per hour, shape only
STARTS = (24, 28, 32, 36, 40, 44, 48, 52)        # 06:00 to 13:00 in half hours: early, day and late shifts together
LENGTH = 34                                       # 8.5 h with a 30-minute unpaid meal


def build(n_emp, days, first_dow=0, mode=0, limit=60, coverage=0.55):
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=first_dow, time_limit_sec=limit, w_under=900, w_over=30, w_hours=50, w_pref=20, w_fair=30, workers=8,
                                  consistency_mode=mode, start_tol_slots=0, end_tol_slots=0, w_consist=200)
    for d in range(days):
        weekend = (first_dow + d) % 7 >= 5
        for s in range(SPD):
            req.required.append(int(CURVE[s // 4] * (0.4 if weekend else 1.0) * n_emp * coverage / 16))
    for e in range(n_emp):
        req.employees.add(id=e + 1, max_week_slots=40 * 4, min_week_slots=40 * 4, max_consecutive=6, rest_slots=44, max_days_week=5)
        for d in range(days):
            for t, st in enumerate(STARTS):
                req.options.add(employee=e + 1, day=d, template=t % 3, start_slot=st, length_slots=LENGTH, paid_slots=LENGTH - 2, preference=0)
    return req


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('sizes', nargs='*', type=int, default=[50, 100, 250, 500, 1000])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--limit', type=int, default=60, help='solver time limit in seconds')
    ap.add_argument('--consistency', choices=['off', 'prefer', 'require'], default='off')
    ap.add_argument('--out', help='write the results as a markdown table to this file')
    a = ap.parse_args()
    mode = {'off': 0, 'prefer': 1, 'require': 2}[a.consistency]
    head = f'{platform.processor() or platform.machine()} · {os.cpu_count()} logical CPUs · Python {platform.python_version()} · OR-Tools CP-SAT'
    print(head)
    rows = []
    for n in a.sizes:
        req = build(n, a.days, mode=mode, limit=a.limit)
        t0 = time.time()
        res = scheduling.solve_period(req)
        wall = time.time() - t0
        need = sum(req.required)
        covered = 1 - (res.under_slots / need) if need else 1.0
        people = len({x.employee for x in res.assignments})
        base_under, base_over = scheduling.baseline_coverage(req)
        base = 1 - base_under / need if need else 1.0
        row = (n, len(req.options), res.status, round(wall, 1), len(res.assignments), people, round(covered * 100, 1), res.variables, res.constraints, round(base * 100, 1), base_over, res.over_slots)
        rows.append(row)
        print(f'{n:>5} agents  {row[1]:>8} options  {row[2]:<9} {row[3]:>6}s  {row[4]:>6} shifts  {row[5]:>5} people  {row[6]:>5}% covered (greedy alone {row[9]}%)  over {row[11]} vs {row[10]}  {row[7]:>8} vars')
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(f'# Scheduling solver benchmark\n\nMachine: {head}\n\nSettings: {a.days} days, solver limit {a.limit} s, same start and end time: {a.consistency}. Synthetic crews of 40-hour, five-day agents; three shift shapes; demand sized to 55% of the crew.\n\n')
            f.write('| Agents | Candidate shifts | Result | Time (s) | Shifts | People used | Requirement covered | Model variables |\n|---:|---:|---|---:|---:|---:|---:|---:|\n')
            for r in rows:
                f.write(f'| {r[0]} | {r[1]:,} | {r[2]} | {r[3]} | {r[4]:,} | {r[5]} | {r[6]}% | {r[9]}% | {r[11]:,} / {r[10]:,} | {r[7]:,} |\n')
            f.write('\nResult: OPTIMAL is proven best; FEASIBLE is a good schedule found inside the time limit; UNKNOWN means nothing was found in time.\n')


if __name__ == '__main__':
    main()
