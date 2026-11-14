/**
 * Reporting lines in bulk, as pure functions: no database, so every rule can be tested.
 *   planAssignments: which proposed lines can be applied, and which cannot (a person reporting to themselves, or a line that would make a loop: A under B under A). Applied in order,
 *                    each one counted against the lines already accepted, so two proposals that are fine alone but loop together are not both accepted.
 *   parseLines:      a CSV of "who reports to whom" (the file the org chart exports is one): the employee and manager columns found by name, rows with no manager left alone.
 */

export interface Proposal { id: string; boss: string }
export type Rejection = 'SELF' | 'CYCLE';

export function planAssignments(current: Map<string, string | null>, proposals: Proposal[]) {
  const lines = new Map(current);
  const accepted: Proposal[] = [], rejected: { proposal: Proposal; why: Rejection }[] = [];
  let unchanged = 0;
  for (const p of proposals) {
    if (p.id === p.boss) { rejected.push({ proposal: p, why: 'SELF' }); continue; }
    if (lines.get(p.id) === p.boss) { unchanged++; continue; }
    let up: string | null | undefined = p.boss, steps = 0, loops = false;
    while (up) {                                          // walk up from the new boss: reaching the person again means a loop
      if (up === p.id || ++steps > 100) { loops = true; break; }
      up = lines.get(up) ?? null;
    }
    if (loops) { rejected.push({ proposal: p, why: 'CYCLE' }); continue; }
    lines.set(p.id, p.boss);
    accepted.push(p);
  }
  return { accepted, rejected, unchanged };
}

const EMPLOYEE = ['employee_number', 'employee_id', 'employee', 'number', 'emp_no', 'id'];
const BOSS = ['reports_to_number', 'reports_to', 'manager_number', 'manager_id', 'manager', 'supervisor_number', 'supervisor', 'boss_number', 'boss'];

export interface ParsedLines { rows: { line: number; employee: string; boss: string }[]; blank: number; error: string | null }

/** `matrix` is the parsed CSV (header row first). Rows with an employee but no manager are counted and left alone: a blank is "not decided", never "remove the line". */
export function parseLines(matrix: string[][]): ParsedLines {
  const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^﻿/, '');
  const head = (matrix[0] ?? []).map(norm);
  const ei = head.findIndex((h) => EMPLOYEE.includes(h));
  // the exported file also has "reports_to" as a NAME column after "reports_to_number": prefer the number column
  const bi = head.indexOf('reports_to_number') >= 0 ? head.indexOf('reports_to_number') : head.findIndex((h) => BOSS.includes(h));
  if (ei < 0 || bi < 0) return { rows: [], blank: 0, error: `The file needs a column for the employee number (employee_number) and one for who they report to (reports_to_number). Found: ${head.filter(Boolean).join(', ') || 'no header row'}.` };
  const rows: ParsedLines['rows'] = [];
  let blank = 0;
  matrix.slice(1).forEach((r, i) => {
    const employee = (r[ei] ?? '').trim(), boss = (r[bi] ?? '').trim();
    if (!employee && !boss) return;
    if (!boss) { blank++; return; }
    rows.push({ line: i + 2, employee, boss });
  });
  return { rows, blank, error: null };
}
