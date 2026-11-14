/**
 * Generate Schedule › follow a rotation pattern. Builds the roster of a fixed cycle (4 on 4 off, Pitman, DuPont...) for the people on it, as far ahead as asked.
 * No forecast is involved. It is the same action as Rotation Patterns › Generate the roster, offered here so a planner does not have to change screens.
 */
import React, { useEffect, useState } from 'react';
import { addDays, api, dayYear, RotationPattern } from '../../services/api';
import { Banner, Btn, Card, Field, Input, Select } from '../forecasting/ui';

export const RotationBuild: React.FC<{ patterns: RotationPattern[]; selectedId?: string; canGenerate: boolean; go: (sub: string) => void; onChanged: () => void }> = ({ patterns, selectedId, canGenerate, go, onChanged }) => {
  const [id, setId] = useState(patterns[0]?.id ?? '');
  const pattern = patterns.find((p) => p.id === (selectedId ?? id)) ?? patterns[0];
  const [through, setThrough] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState('');
  useEffect(() => { setThrough(''); setMade(''); }, [selectedId]);
  if (!pattern) return null;

  const defaultThrough = addDays(pattern.materializedThrough ?? pattern.anchorDate, 28);
  const to = through || defaultThrough;

  const generate = async () => {
    setBusy(true); setError(''); setMade('');
    try {
      const r = await api<{ shiftsPlaced: number; days: number; holidaysSkipped: number }>(`/scheduling/rotations/${pattern.id}/materialize`, { method: 'POST', body: { through: to } });
      setMade(`Generated ${r.shiftsPlaced} shift${r.shiftsPlaced === 1 ? '' : 's'} across ${r.days} days for ${pattern.memberCount} ${pattern.memberCount === 1 ? 'person' : 'people'}.${r.holidaysSkipped ? ` Skipped ${r.holidaysSkipped} holiday day${r.holidaysSkipped === 1 ? '' : 's'}.` : ''}`);
      onChanged();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="Generate the rotation roster" sub="Turns the pattern into real shifts for the people on it. It does not use the forecast. Safe to run again later to extend the roster.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {selectedId ? <div><div className="text-[12px] font-semibold mb-1.5">Rotation pattern</div><div className="text-[13px]">{pattern.name} ({pattern.memberCount} {pattern.memberCount === 1 ? 'person' : 'people'})</div></div> : (
          <Field label="Rotation pattern">
            <Select value={pattern.id} onChange={(e) => { setId(e.target.value); setThrough(''); setMade(''); }}>
              {patterns.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.memberCount} {p.memberCount === 1 ? 'person' : 'people'})</option>)}
            </Select>
          </Field>
        )}
        <Field label="Generate through" hint={pattern.materializedThrough ? `Already generated through ${dayYear(pattern.materializedThrough)}` : 'Not generated yet'}>
          <Input type="date" min={pattern.anchorDate} value={to} onChange={(e) => setThrough(e.target.value)} />
        </Field>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div><dt className="text-[11px] text-[#737373]">Cycle</dt><dd className="text-[#171717]">{pattern.cycleDays} days</dd></div>
        <div><dt className="text-[11px] text-[#737373]">Crews</dt><dd className="text-[#171717]">{pattern.crews.map((c) => c.name).join(', ') || 'None'}</dd></div>
        <div><dt className="text-[11px] text-[#737373]">Holidays</dt><dd className="text-[#171717]">{pattern.observesHolidays ? 'Skipped' : 'Worked'}</dd></div>
      </dl>
      {!pattern.memberCount && <p className="mt-3 text-[12px] text-[#8F6200]">No one is in this pattern's crews yet. Add people to the crews on Rotation Patterns first.</p>}
      {error && <div className="mt-3"><Banner kind="err" onClose={() => setError('')}>{error}</Banner></div>}
      {made && (
        <div className="mt-3"><Banner kind="ok">{made} <button type="button" className="underline font-semibold ml-1" onClick={() => go('schedule-timeline')}>Open it in Schedule Timeline</button> to review and publish.</Banner></div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canGenerate ? <Btn variant="primary" disabled={busy || !pattern.memberCount || !to} onClick={generate}>{busy ? 'Generating...' : 'Generate the roster'}</Btn> : <span className="text-[12px] text-[#6B6B6B]">You do not have permission to generate schedules.</span>}
        <button type="button" className="text-[12px] underline text-[#525252]" onClick={() => go('rotations')}>Edit the pattern or its crews</button>
      </div>
    </Card>
  );
};
