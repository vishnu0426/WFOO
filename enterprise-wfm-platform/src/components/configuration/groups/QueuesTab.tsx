/** A group's queues: channel, the skill each needs, handle time, and the other names the phone system or a file uses for it (aliases). */
import React, { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, CHANNEL_LABEL, Channel, GroupDto, Queue, Skill } from '../../../services/api';
import { Banner, Btn, Empty, Field, Input, Pill, Select, Table } from '../../forecasting/ui';
import { useApi } from '../../forecasting/hooks';
import { Confirm } from './shared';

type Form = { id: string | null; name: string; channel: Channel; ahtDefault: number; concurrency: number; turnaroundHours: number; skillId: string; aliases: string };
const blank = (): Form => ({ id: null, name: '', channel: 'VOICE', ahtDefault: 300, concurrency: 2, turnaroundHours: 24, skillId: '', aliases: '' });
const fromQueue = (q: Queue): Form => ({ id: q.id, name: q.name, channel: q.channel, ahtDefault: q.ahtDefault, concurrency: q.concurrency, turnaroundHours: q.turnaroundHours ?? 24, skillId: q.skillId ?? '', aliases: (q.aliases ?? []).join(', ') });
const turnaroundLabel = (h: number | null) => (!h || h <= 24 ? 'same day' : h % 24 === 0 ? `${h / 24}d turnaround` : `${h}h turnaround`);

export const QueuesTab: React.FC<{ group: GroupDto; queues: Queue[]; canWrite: boolean; onChange: () => Promise<void> }> = ({ group, queues, canWrite, onChange }) => {
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<{ q: Queue; history?: string; error?: string } | null>(null);
  const skills = useApi<Skill[]>('/workforce/skills');
  const skillName = (id?: string | null) => (skills.data ?? []).find((s) => s.id === id)?.name ?? 'Any skill';

  const save = async () => {
    if (!f) return;
    setBusy(true); setError('');
    const aliases = f.aliases.split(/[,\n]/).map((a) => a.trim()).filter(Boolean);
    try {
      if (f.id) await api(`/config/queues/${f.id}`, { method: 'PUT', body: { name: f.name, ahtDefault: f.ahtDefault, skillId: f.skillId || null, aliases, ...(f.channel === 'CHAT' ? { concurrency: f.concurrency } : {}), ...(f.channel === 'BACKOFFICE' ? { turnaroundHours: f.turnaroundHours } : {}) } });
      else await api('/config/queues', { method: 'POST', body: { name: f.name, channel: f.channel, ahtDefault: f.ahtDefault, wfmGroupId: group.id, aliases, ...(f.channel === 'CHAT' ? { concurrency: f.concurrency } : {}), ...(f.channel === 'BACKOFFICE' ? { turnaroundHours: f.turnaroundHours } : {}), ...(f.skillId ? { skillId: f.skillId } : {}) } });
      setF(null); await onChange();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (force: boolean) => {
    if (!del) return;
    setBusy(true);
    try { await api(`/config/queues/${del.q.id}${force ? '?force=true' : ''}`, { method: 'DELETE' }); setDel(null); await onChange(); }
    catch (e: any) { if (e.status === 409 && !force) setDel({ q: del.q, history: e.message }); else setDel({ ...del, error: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {queues.length === 0 && !f ? <Empty title="No queues yet">A queue is one stream of contacts, such as phone or chat. {canWrite ? 'Add the first one below.' : ''}</Empty> : queues.length > 0 && (
        <Table head={['Queue', 'Channel', 'Skill needed', 'Other names (aliases)', 'Handle time', '']} right={[4, 5]}>
          {queues.map((q) => (
            <tr key={q.id}>
              <td className="p-2.5"><div className="font-medium">{q.name}</div><div className="text-[11px] font-mono text-[#6B6B6B]">{q.code}</div></td>
              <td className="p-2.5">{CHANNEL_LABEL[q.channel]}{q.channel === 'CHAT' ? ` · ${q.concurrency} at once` : q.channel === 'BACKOFFICE' ? ` · ${turnaroundLabel(q.turnaroundHours)}` : ''}</td>
              <td className="p-2.5 text-[#525252]">{skillName(q.skillId)}</td>
              <td className="p-2.5">{(q.aliases ?? []).length ? <div className="flex flex-wrap gap-1">{q.aliases!.map((a) => <Pill key={a}>{a}</Pill>)}</div> : <span className="text-[#6B6B6B]">None</span>}</td>
              <td className="p-2.5 text-right font-mono">{q.ahtDefault}s</td>
              <td className="p-2.5 text-right whitespace-nowrap">{canWrite && <>
                <button aria-label={`Edit ${q.name}`} className="text-[#6B6B6B] hover:text-[#171717] mr-3" onClick={() => { setError(''); setF(fromQueue(q)); }}><Pencil className="w-4 h-4" /></button>
                <button aria-label={`Delete ${q.name}`} className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setDel({ q })}><Trash2 className="w-4 h-4" /></button>
              </>}</td>
            </tr>
          ))}
        </Table>
      )}
      {canWrite && (f ? (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-3 bg-[#FAFAF8]">
          <div className="text-[13px] font-semibold">{f.id ? `Edit ${f.name || 'queue'}` : 'New queue'}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-start">
            <div className="col-span-2"><Field label="Queue name"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
            <Field label="Channel" hint={f.id ? 'Fixed once created' : undefined}><Select disabled={!!f.id} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as Channel })}>{(['VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</Select></Field>
            <Field label="Handle time (s)"><Input type="number" min={1} max={7200} value={f.ahtDefault} onChange={(e) => setF({ ...f, ahtDefault: Number(e.target.value) })} /></Field>
            <Field label="Skill needed" hint="Queues needing different skills are staffed skill by skill"><Select value={f.skillId} onChange={(e) => setF({ ...f, skillId: e.target.value })}><option value="">Any skill</option>{(skills.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            {f.channel === 'CHAT' && <Field label="Chats at once"><Input type="number" min={1} max={10} value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: Number(e.target.value) })} /></Field>}
            {f.channel === 'BACKOFFICE' && <Field label="Turnaround (hours)" hint="0 or 24 = same day"><Input type="number" min={0} max={720} value={f.turnaroundHours} onChange={(e) => setF({ ...f, turnaroundHours: Number(e.target.value) })} /></Field>}
            <div className="col-span-2"><Field label="Other names (aliases)" hint="How the phone system or your exported files name this queue, separated by commas. A file row with one of these lands here."><Input value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} placeholder="TS_VOICE, Tech Support Voice" /></Field></div>
          </div>
          {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" disabled={busy || !f.name.trim() || !(f.ahtDefault > 0)} onClick={save}>{busy ? 'Saving…' : f.id ? 'Save queue' : 'Add queue'}</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      ) : <div><Btn onClick={() => { setError(''); setF(blank()); }}><Plus className="w-3.5 h-3.5" />Add queue</Btn></div>)}

      {del && (
        <Confirm title={del.history ? `Delete ${del.q.name} and its history?` : `Delete ${del.q.name}?`} confirmLabel={del.history ? 'Delete queue and history' : 'Delete queue'} danger busy={busy} error={del.error}
          onConfirm={() => remove(!!del.history)} onCancel={() => setDel(null)}>
          {del.history ? <p>{del.history.replace(/;.*$/, '.')}</p> : <p>The queue is removed from {group.name}. Forecasts that used it keep their numbers, but new forecasts will not include it.</p>}
        </Confirm>
      )}
    </div>
  );
};
