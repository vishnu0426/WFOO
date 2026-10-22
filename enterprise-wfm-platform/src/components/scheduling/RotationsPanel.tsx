/**
 * Scheduling > Rotation Patterns. A fixed repeating cycle (4-on-4-off, DuPont, Pitman...) assigned once and
 * projected forward indefinitely, independent of any forecast -- for shift work scheduled by pattern rather than
 * matched to demand each period. Materializing writes ordinary shifts into a normal schedule version: open it in
 * Schedule Timeline to drag, edit, validate and publish exactly like any other schedule.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Employee, RotationCrew, RotationMember, RotationPattern, ShiftTemplate, api, dayYear } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export const RotationsPanel: React.FC<{ go: (sub: string) => void }> = ({ go }) => {
  const { group, can, setNotice } = useForecast();
  const canWrite = can('workforce:write');
  const [tick, setTick] = useState(0);
  const patterns = useApi<RotationPattern[]>(group ? `/scheduling/rotations?groupId=${group.id}` : null, [group?.id, tick]);
  const tpls = useApi<ShiftTemplate[]>('/scheduling/templates');
  const [sel, setSel] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (patterns.data && !patterns.data.some((p) => p.id === sel)) setSel(patterns.data[0]?.id ?? ''); }, [patterns.data]);
  const current = patterns.data?.find((p) => p.id === sel) ?? null;

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const remove = (p: RotationPattern) => confirm(`Delete "${p.name}"?`) && run(async () => { await api(`/scheduling/rotations/${p.id}`, { method: 'DELETE' }); setSel(''); });

  if (!group) return <Empty title="No WFM group yet" />;
  if (patterns.loading && !patterns.data) return <Busy text="Loading patterns…" />;

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      <Card title="Rotation patterns" sub={`For ${group.name}. Fixed repeating cycles (4-on-4-off, DuPont, Pitman...) rather than schedules matched to a forecast.`}
        actions={canWrite && <Btn variant="primary" onClick={() => { setCreating(true); setSel(''); }}><Plus className="w-3.5 h-3.5" />New pattern</Btn>}>
        {!patterns.data?.length && !creating ? <Empty title="No rotation patterns yet">Create one for crews that work a fixed cycle instead of a forecast-driven schedule.</Empty> : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(patterns.data ?? []).map((p) => (
              <button key={p.id} onClick={() => { setCreating(false); setSel(p.id); }} className={`text-left p-3 rounded-lg border ${sel === p.id && !creating ? 'border-[#171717] bg-[#FAFAF8]' : 'border-[#E5E5E0] hover:bg-[#FAFAF8]'}`}>
                <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-[13px]">{p.name}</span>{p.status === 'INACTIVE' && <Pill tone="neutral">Inactive</Pill>}</div>
                <div className="text-[11px] text-[#737373] mt-1">{p.cycleDays}-day cycle · {p.crews.length} crew{p.crews.length === 1 ? '' : 's'} · {p.memberCount} people</div>
                <div className="text-[11px] text-[#737373]">{p.materializedThrough ? `Generated through ${dayYear(p.materializedThrough)}` : 'Not generated yet'}</div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {creating && <NewPatternForm groupId={group.id} templates={tpls.data ?? []} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSel(id); setTick((t) => t + 1); }} />}
      {!creating && current && (
        <PatternDetail pattern={current} templates={tpls.data ?? []} canWrite={canWrite} busy={busy} run={run} onDelete={() => remove(current)} go={go} />
      )}
    </div>
  );
};

const NewPatternForm: React.FC<{ groupId: string; templates: ShiftTemplate[]; onCancel: () => void; onCreated: (id: string) => void }> = ({ groupId, templates, onCancel, onCreated }) => {
  const [name, setName] = useState('');
  const [cycleDays, setCycleDays] = useState(8);
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [observesHolidays, setObservesHolidays] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setError('');
    try {
      const sequence = new Array(cycleDays).fill(null);
      const c = await api<RotationPattern>('/scheduling/rotations', { method: 'POST', body: { wfmGroupId: groupId, name, cycleDays, sequence, crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate, observesHolidays } });
      onCreated(c.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title="New pattern">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="4-on-4-off nights" /></Field>
        <Field label="Cycle length (days)" hint="e.g. 8 for a 4-on-4-off pattern"><Input type="number" min={2} max={84} value={cycleDays} onChange={(e) => setCycleDays(Math.max(2, Math.min(84, Number(e.target.value) || 2)))} /></Field>
        <Field label="Anchor date" hint="day 0 of the cycle"><Input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} /></Field>
        <div className="flex gap-2"><Btn variant="primary" disabled={busy || !name.trim() || !templates.length} onClick={create}>Create</Btn><Btn onClick={onCancel}>Cancel</Btn></div>
      </div>
      <label className="flex items-center gap-2 text-[12px] mt-3"><input type="checkbox" checked={observesHolidays} onChange={(e) => setObservesHolidays(e.target.checked)} />Skip generating a work shift on days marked as a holiday (Forecasting › special events). Turn off for crews that work through holidays.</label>
      {!templates.length && <p className="text-[12px] text-[#C84A4A] mt-2">Create a shift template first (Scheduling › Shift Templates).</p>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      <p className="text-[11px] text-[#737373] mt-2">You will set the day-by-day sequence, crews and who is in them next.</p>
    </Card>
  );
};

const PatternDetail: React.FC<{
  pattern: RotationPattern; templates: ShiftTemplate[]; canWrite: boolean; busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>; onDelete: () => void; go: (sub: string) => void;
}> = ({ pattern, templates, canWrite, busy, run, onDelete, go }) => {
  const [seq, setSeq] = useState<(string | null)[]>(pattern.sequence);
  const [crews, setCrews] = useState<RotationCrew[]>(pattern.crews);
  const [observesHolidays, setObservesHolidays] = useState(pattern.observesHolidays);
  useEffect(() => { setSeq(pattern.sequence); setCrews(pattern.crews); setObservesHolidays(pattern.observesHolidays); }, [pattern.id, pattern.version]);
  const dirty = JSON.stringify(seq) !== JSON.stringify(pattern.sequence) || JSON.stringify(crews) !== JSON.stringify(pattern.crews) || observesHolidays !== pattern.observesHolidays;

  const save = () => run(async () => { await api(`/scheduling/rotations/${pattern.id}`, { method: 'PUT', body: { name: pattern.name, cycleDays: pattern.cycleDays, sequence: seq, crews, anchorDate: pattern.anchorDate, status: pattern.status, observesHolidays } }); });
  const toggleActive = () => run(async () => { await api(`/scheduling/rotations/${pattern.id}`, { method: 'PUT', body: { name: pattern.name, cycleDays: pattern.cycleDays, sequence: pattern.sequence, crews: pattern.crews, anchorDate: pattern.anchorDate, status: pattern.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE', observesHolidays: pattern.observesHolidays } }); });

  const [through, setThrough] = useState(addDays(pattern.materializedThrough ?? pattern.anchorDate, 90));
  const [result, setResult] = useState('');
  const materialize = () => run(async () => {
    const r = await api<{ shiftsPlaced: number; days: number; holidaysSkipped: number; versionId: string }>(`/scheduling/rotations/${pattern.id}/materialize`, { method: 'POST', body: { through } });
    setResult(`Generated ${r.shiftsPlaced} shift${r.shiftsPlaced === 1 ? '' : 's'} across ${r.days} days.${r.holidaysSkipped ? ` Skipped ${r.holidaysSkipped} holiday day${r.holidaysSkipped === 1 ? '' : 's'}.` : ''}`);
  });
  const [ver, setVer] = useState<{ status: string; id: string } | null>(null);
  useEffect(() => { setVer(null); if (pattern.versionId) api(`/scheduling/versions/${pattern.versionId}`).then((v: any) => setVer({ status: v.status, id: v.id })).catch(() => {}); }, [pattern.versionId, pattern.materializedThrough]);
  const publish = () => run(async () => { await api(`/scheduling/versions/${pattern.versionId}/publish`, { method: 'POST' }); });

  const tplName = (id: string | null) => (id ? templates.find((t) => t.id === id)?.name ?? '?' : 'Off');

  return (
    <div className="space-y-6">
      <Card title={pattern.name} sub={`Cycle day 0 is ${dayYear(pattern.anchorDate)}. Each crew works the same sequence, offset by its own number of days.`}
        actions={canWrite && <>
          <Btn onClick={toggleActive} disabled={busy}>{pattern.status === 'ACTIVE' ? 'Set inactive' : 'Set active'}</Btn>
          <Btn onClick={onDelete} disabled={busy}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>
        </>}>
        <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
          <table className="text-[12px]">
            <thead className="bg-[#FAFAF8] text-[#737373] border-b border-[#E5E5E0]"><tr><th className="p-2 text-left w-24">Cycle day</th>{seq.map((_, i) => <th key={i} className="p-2 text-center min-w-[100px]">{i}</th>)}</tr></thead>
            <tbody><tr>
              <td className="p-2 font-semibold">Shift</td>
              {seq.map((tplId, i) => (
                <td key={i} className="p-1.5">
                  <Select disabled={!canWrite} value={tplId ?? ''} onChange={(e) => setSeq((s) => s.map((x, j) => (j === i ? (e.target.value || null) : x)))}>
                    <option value="">Off</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </td>
              ))}
            </tr></tbody>
          </table>
        </div>

        <div className="space-y-2">
          <div className="text-[13px] font-semibold">Crews</div>
          {crews.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input disabled={!canWrite} value={c.name} onChange={(e) => setCrews((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-[180px]" />
              <span className="text-[12px] text-[#737373]">offset</span>
              <Input disabled={!canWrite} type="number" min={0} max={pattern.cycleDays - 1} value={c.offsetDays} onChange={(e) => setCrews((cs) => cs.map((x, j) => (j === i ? { ...x, offsetDays: Math.max(0, Math.min(pattern.cycleDays - 1, Number(e.target.value) || 0)) } : x)))} className="max-w-[90px]" />
              <span className="text-[11px] text-[#737373]">days into the cycle</span>
              {canWrite && crews.length > 1 && <button className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setCrews((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
          {canWrite && <Btn onClick={() => setCrews((cs) => [...cs, { name: `Crew ${String.fromCharCode(65 + cs.length)}`, offsetDays: 0 }])}><Plus className="w-3.5 h-3.5" />Add crew</Btn>}
        </div>

        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" disabled={!canWrite} checked={observesHolidays} onChange={(e) => setObservesHolidays(e.target.checked)} />Skip generating a work shift on days marked as a holiday</label>

        {canWrite && <div className="flex items-center gap-2"><Btn variant="primary" disabled={busy || !dirty} onClick={save}>Save changes</Btn>{dirty && <span className="text-[12px] text-[#B7791F]">Unsaved changes</span>}</div>}
      </Card>

      <MembersPanel pattern={pattern} canWrite={canWrite} />

      <Card title="Generate the roster" sub="Turns the pattern into real shifts, as far ahead as you like. Safe to run again later to extend it further.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Generate through"><Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <Btn variant="primary" disabled={busy || !pattern.memberCount} onClick={materialize}>Generate</Btn>
          {ver && ver.status === 'DRAFT' && canWrite && <Btn variant="success" disabled={busy} onClick={publish}>Publish roster</Btn>}
          {ver && <Pill tone={ver.status === 'PUBLISHED' ? 'good' : 'warn'}>{ver.status === 'PUBLISHED' ? 'Published' : 'Draft'}</Pill>}
        </div>
        {!pattern.memberCount && <p className="text-[12px] text-[#C84A4A] mt-2">Add people to a crew below first.</p>}
        {result && <p className="text-[12px] text-[#2F7D5A] mt-2">{result}</p>}
        {pattern.versionId && <p className="text-[12px] mt-2">Open <button className="underline" onClick={() => go('schedule-timeline')}>Schedule Timeline</button> and pick "{pattern.name}" from the version list to see, edit or drag the shifts.</p>}
      </Card>
    </div>
  );
};

type Assign = { crewName: string; effectiveFrom: string; effectiveTo: string };
const blankAssign: Assign = { crewName: '', effectiveFrom: '', effectiveTo: '' };

const MembersPanel: React.FC<{ pattern: RotationPattern; canWrite: boolean }> = ({ pattern, canWrite }) => {
  const [tick, setTick] = useState(0);
  const emps = useApi<Employee[]>(`/workforce/employees?groupId=${pattern.wfmGroupId}&status=ACTIVE`);
  const current = useApi<RotationMember[]>(`/scheduling/rotations/${pattern.id}/members`, [pattern.id, tick]);
  const [assign, setAssign] = useState<Record<string, Assign>>({});
  useEffect(() => { setAssign(Object.fromEntries((current.data ?? []).map((m) => [m.employeeId, { crewName: m.crewName, effectiveFrom: m.effectiveFrom ?? '', effectiveTo: m.effectiveTo ?? '' }]))); }, [current.data]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const members = Object.entries(assign).filter(([, a]) => a.crewName).map(([employeeId, a]) => ({ employeeId, crewName: a.crewName, effectiveFrom: a.effectiveFrom || null, effectiveTo: a.effectiveTo || null }));
      const r = await api<{ resync: { added: number; removed: number } | null }>(`/scheduling/rotations/${pattern.id}/members`, { method: 'PUT', body: { members } });
      if (r.resync && (r.resync.added || r.resync.removed)) setNotice(`Already-generated shifts updated to match: ${r.resync.added} set, ${r.resync.removed} removed.`);
      setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Crew members" sub="Who is in each crew, and optionally when. Leave the dates blank for someone who is simply always in the crew; set them for a mid-cycle join or leave.">
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      {!emps.data?.length ? <Empty title="No people in this WFM group yet" /> : (
        <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F0F0EC] border border-[#E5E5E0] rounded-lg">
          {emps.data.map((e) => {
            const a = assign[e.id] ?? blankAssign;
            return (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
                <span className="text-[13px] min-w-[160px]">{e.name} <span className="text-[11px] text-[#737373] font-mono">{e.employeeNumber}</span></span>
                <div className="flex items-center gap-2">
                  <Select disabled={!canWrite} value={a.crewName} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, crewName: ev.target.value } }))} className="!w-auto min-w-[160px]">
                    <option value="">Not in this pattern</option>{pattern.crews.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </Select>
                  {a.crewName && canWrite && <>
                    <Input type="date" title="Joins on (optional)" disabled={!canWrite} value={a.effectiveFrom} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, effectiveFrom: ev.target.value } }))} className="!w-auto" />
                    <span className="text-[11px] text-[#737373]">to</span>
                    <Input type="date" title="Leaves after (optional)" disabled={!canWrite} value={a.effectiveTo} onChange={(ev) => setAssign((s) => ({ ...s, [e.id]: { ...a, effectiveTo: ev.target.value } }))} className="!w-auto" />
                  </>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {canWrite && <Btn variant="primary" disabled={busy} onClick={save}>Save crew members</Btn>}
    </Card>
  );
};
