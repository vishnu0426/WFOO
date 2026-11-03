/**
 * Administration › Alerts & Reports. How the platform reaches people outside the app (email, and SMS through your own SMS gateway), which events tell which roles, and
 * reports that arrive on a timetable. Passwords and gateway keys are never shown again after they are saved.
 */
import React, { useEffect, useState } from 'react';
import { api, download } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Field, Input, Pill, Select } from '../forecasting/ui';

type Field = { key: string; label: string; secret?: boolean; required?: boolean; help?: string; placeholder?: string; options?: { value: string; label: string }[]; default?: string; advanced?: boolean; multiline?: boolean };
type Provider = { id: string; label: string; kind: 'SMTP' | 'API' | 'HTTP'; help: string; fields: Field[] };
type Side = { enabled: boolean; provider: string; values: Record<string, string>; saved: Record<string, boolean> };
type Settings = { email: Side & { from: string }; sms: Side; defaults: Record<string, string[]> };
type Rule = { id: string; name: string; event: string; roles: string[]; channels: string[]; active: boolean };
type Sched = { id: string; name: string; report: string; groupName: string | null; groupId: string | null; range: string; frequency: string; dayOfWeek: number | null; dayOfMonth: number | null; hour: number; timezone: string; recipients: { emails: string[]; roles: string[] }; enabled: boolean; format: 'CSV' | 'PDF' | 'BOTH'; nextRunAt: string | null; lastRunAt: string | null };
type SRun = { id: string; status: 'OK' | 'FAILED'; rows: number; error: string | null; ranAt: string; sentTo: number; from: string; to: string; hasCsv: boolean; hasPdf: boolean };
type Delivery = { id: string; channel: 'EMAIL' | 'SMS'; to: string; subject: string; status: 'PENDING' | 'SENT' | 'FAILED'; attempts: number; error: string | null; ref: string | null; createdAt: string };
const KINDS: [string, string][] = [['TIME_OFF', 'Time off'], ['SWAP', 'Shift swaps'], ['SCHEDULE', 'Schedule changes'], ['OFFER', 'Time-off and overtime offers'], ['BID', 'Shift bidding'], ['INFO', 'Everything else']];
const ROLES: [string, string][] = [['WFM_ADMIN', 'Administrators'], ['WFM_MANAGER', 'Managers'], ['SCHEDULER', 'Schedulers'], ['FORECAST_PLANNER', 'Planners'], ['SUPERVISOR_RTA', 'Supervisors'], ['ANALYST', 'Analysts']];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const tone = (s: string) => (s === 'SENT' || s === 'OK' ? 'good' : s === 'PENDING' ? 'warn' : 'bad') as 'good' | 'warn' | 'bad';

export const AlertsReportsView: React.FC = () => {
  const { can } = useForecast();
  const [tab, setTab] = useState<'CHANNELS' | 'RULES' | 'REPORTS' | 'SENT'>('CHANNELS');
  const tabs: [typeof tab, string][] = [['CHANNELS', 'Email & SMS'], ['RULES', 'Alert rules'], ['REPORTS', 'Scheduled reports'], ['SENT', 'Sent messages']];
  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-y-auto bg-white p-6 space-y-6">
      <div><h1 className="text-[22px] font-bold text-[#171717]">Alerts & Reports</h1><p className="text-[13px] text-[#6B6B6B]">Reach people by email and SMS, tell the right roles when something happens, and send reports on a timetable.</p></div>
      <div className="flex gap-1 border-b border-[#E5E5E0]">{tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-[13px] font-medium border-b-2 -mb-px ${tab === k ? 'border-[#171717] text-[#171717]' : 'border-transparent text-[#6B6B6B]'}`}>{l}</button>)}</div>
      {tab === 'CHANNELS' && <Channels canWrite={can('users:write')} />}
      {tab === 'RULES' && <Rules canWrite={can('users:write')} />}
      {tab === 'REPORTS' && <Reports canWrite={can('config:write')} />}
      {tab === 'SENT' && <Sent canWrite={can('users:write')} />}
    </div>
  );
};

/** The boxes a provider needs. Which boxes there are, and what each one is for, comes from the provider chosen. */
const ProviderForm: React.FC<{ provider: Provider; values: Record<string, string>; saved: Record<string, boolean>; canWrite: boolean; onChange: (key: string, v: string) => void }> = ({ provider, values, saved, canWrite, onChange }) => {
  const [more, setMore] = useState(false);
  const shown = provider.fields.filter((f) => !f.advanced || more);
  const advanced = provider.fields.some((f) => f.advanced);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[#525252]">{provider.help}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        {shown.map((f) => {
          const v = values[f.key] ?? f.default ?? '';
          const hint = f.help ?? (f.secret && saved[f.key] ? 'One is saved. Leave empty to keep it' : undefined);
          return (
            <div key={f.key} className={f.multiline ? 'md:col-span-2' : ''}>
              <Field label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.secret && saved[f.key] && f.help ? `${f.help} One is saved: leave empty to keep it.` : hint}>
                {f.options ? <Select disabled={!canWrite} value={v} onChange={(e) => onChange(f.key, e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                  : f.multiline ? <textarea disabled={!canWrite} rows={3} className="w-full p-2 border border-[#E5E5E0] rounded text-[12px] font-mono" value={v} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.secret && saved[f.key] ? '•••••• (saved)' : f.placeholder} />
                  : <Input type={f.secret ? 'password' : 'text'} autoComplete="off" disabled={!canWrite} value={v} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.secret && saved[f.key] ? '••••••••' : f.placeholder} />}
              </Field>
            </div>
          );
        })}
      </div>
      {advanced && <button type="button" className="text-[12px] underline" onClick={() => setMore(!more)}>{more ? 'Hide the advanced boxes' : 'Show advanced boxes'}</button>}
    </div>
  );
};

const Channels: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const res = useApi<Settings>('/channels/settings');
  const cat = useApi<{ email: Provider[]; sms: Provider[] }>('/channels/providers');
  const [d, setD] = useState<Settings | null>(null);
  const [testTo, setTestTo] = useState({ EMAIL: '', SMS: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (res.data) setD(res.data); }, [res.data]);
  if (!d || !cat.data) return res.error || cat.error ? <Banner kind="err">{res.error || cat.error}</Banner> : <Busy text="Loading…" />;
  const emailP = cat.data.email.find((p) => p.id === d.email.provider) ?? cat.data.email[0], smsP = cat.data.sms.find((p) => p.id === d.sms.provider) ?? cat.data.sms[0];
  // choosing another provider starts its boxes fresh: nothing typed for one provider is sent to another
  const pick = (side: 'email' | 'sms', id: string) => setD({ ...d, [side]: { ...d[side], provider: id, values: {}, saved: {} } });
  const set = (side: 'email' | 'sms', k: string, v: string) => setD({ ...d, [side]: { ...d[side], values: { ...d[side].values, [k]: v } } });
  const body = () => ({ email: { enabled: d.email.enabled, provider: emailP.id, from: d.email.from, values: d.email.values }, sms: { enabled: d.sms.enabled, provider: smsP.id, values: d.sms.values }, defaults: d.defaults });
  const save = async (quiet = false) => {
    try { const out = await api<Settings>('/channels/settings', { method: 'PUT', body: body() }); setD(out); if (!quiet) setMsg({ kind: 'ok', text: 'Saved.' }); return true; }
    catch (e: any) { setMsg({ kind: 'err', text: e.message }); return false; }
  };
  const test = async (channel: 'EMAIL' | 'SMS') => {
    setBusy(true); setMsg(null);
    try {
      if (!(await save(true))) return;
      const r = await api<{ ok: boolean; error?: string }>('/channels/test', { method: 'POST', body: { channel, to: testTo[channel] } });
      setMsg(r.ok ? { kind: 'ok', text: `Saved, and the test ${channel === 'EMAIL' ? 'email' : 'text'} was accepted by the provider.` } : { kind: 'err', text: `Saved, but the test failed: ${r.error ?? 'it was not accepted'}` });
    } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const toggleDefault = (kind: string, ch: string) => { const cur = new Set(d.defaults[kind] ?? []); cur.has(ch) ? cur.delete(ch) : cur.add(ch); setD({ ...d, defaults: { ...d.defaults, [kind]: [...cur] } }); };
  const options = (list: Provider[]) => <>{(['SMTP', 'API', 'HTTP'] as const).map((k) => { const items = list.filter((p) => p.kind === k); return items.length ? <optgroup key={k} label={k === 'SMTP' ? 'Through SMTP (a mail server)' : k === 'API' ? 'Through the provider\'s web API' : 'Custom'}>{items.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup> : null; })}</>;
  return (
    <div className="space-y-6">
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <Card title="Email" sub="Choose the service that sends your email. The boxes below change to match what that service needs. Messages are queued and tried again if the service is down.">
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" disabled={!canWrite} checked={d.email.enabled} onChange={(e) => setD({ ...d, email: { ...d.email, enabled: e.target.checked } })} /><b>Send email</b></label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
          <Field label="Email provider"><Select disabled={!canWrite} value={emailP.id} onChange={(e) => pick('email', e.target.value)}>{options(cat.data.email)}</Select></Field>
          <Field label="Send from" hint="The sender address. Most providers only accept one they have verified."><Input disabled={!canWrite} value={d.email.from} onChange={(e) => setD({ ...d, email: { ...d.email, from: e.target.value } })} placeholder="WFM <wfm@example.com>" /></Field>
        </div>
        <ProviderForm key={`e-${emailP.id}`} provider={emailP} values={d.email.values} saved={d.email.saved} canWrite={canWrite} onChange={(k, v) => set('email', k, v)} />
        {canWrite && <div className="flex flex-wrap items-end gap-2 border-t border-[#E5E5E0] pt-3"><Field label="Send a test to"><Input className="!w-72" value={testTo.EMAIL} onChange={(e) => setTestTo({ ...testTo, EMAIL: e.target.value })} placeholder="you@example.com" /></Field><Btn disabled={!testTo.EMAIL || busy} onClick={() => test('EMAIL')}>Save and send test email</Btn></div>}
      </Card>

      <Card title="SMS" sub="Choose the service that sends your texts. Phone numbers come from the employee record. Use “Any web gateway” for a carrier, Kannel, Gammu or any service not in the list.">
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" disabled={!canWrite} checked={d.sms.enabled} onChange={(e) => setD({ ...d, sms: { ...d.sms, enabled: e.target.checked } })} /><b>Send SMS</b></label>
        <div className="max-w-xl"><Field label="SMS provider"><Select disabled={!canWrite} value={smsP.id} onChange={(e) => pick('sms', e.target.value)}>{cat.data.sms.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></Field></div>
        <ProviderForm key={`s-${smsP.id}`} provider={smsP} values={d.sms.values} saved={d.sms.saved} canWrite={canWrite} onChange={(k, v) => set('sms', k, v)} />
        {canWrite && <div className="flex flex-wrap items-end gap-2 border-t border-[#E5E5E0] pt-3"><Field label="Send a test to"><Input className="!w-72" value={testTo.SMS} onChange={(e) => setTestTo({ ...testTo, SMS: e.target.value })} placeholder="+15551234567" /></Field><Btn disabled={!testTo.SMS || busy} onClick={() => test('SMS')}>Save and send test text</Btn></div>}
      </Card>

      <Card title="Who gets what by default" sub="Everyone sees these in the app. Tick email or SMS to also send them that way unless a person chooses otherwise in the app.">
        <table className="text-[13px]"><thead className="text-left text-[#6B6B6B]"><tr><th className="pr-8 py-1">Kind of message</th><th className="px-4">Email</th><th className="px-4">SMS</th></tr></thead>
          <tbody>{KINDS.map(([k, l]) => <tr key={k} className="border-t border-[#E5E5E0]"><td className="py-1.5 pr-8">{l}</td>{['EMAIL', 'SMS'].map((ch) => <td key={ch} className="px-4"><input type="checkbox" aria-label={`${l} by ${ch === 'EMAIL' ? 'email' : 'SMS'}`} disabled={!canWrite} checked={(d.defaults[k] ?? []).includes(ch)} onChange={() => toggleDefault(k, ch)} /></td>)}</tr>)}</tbody></table>
      </Card>
      {canWrite && <div><Btn variant="primary" disabled={busy} onClick={() => save()}>Save</Btn></div>}
    </div>
  );
};

const Rules: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [tick, setTick] = useState(0);
  const rules = useApi<Rule[]>('/channels/alert-rules', [tick]);
  const events = useApi<{ id: string; label: string }[]>('/developer/events');
  const [f, setF] = useState({ name: '', event: 'schedule.published', roles: ['WFM_MANAGER'] as string[], channels: ['INBOX', 'EMAIL'] as string[] });
  const [err, setErr] = useState('');
  const toggle = (l: string[], v: string) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]);
  const label = (id: string) => (id === '*' ? 'Everything' : events.data?.find((e) => e.id === id)?.label ?? id);
  return (
    <Card title="Alert rules" sub="When one of these things happens, the roles you name are told: in the app, by email, by SMS, or any mix. People with no email or phone on record are skipped.">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      {(rules.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No rules yet.</p> : (
        <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">Rule</th><th>When</th><th>Who</th><th>How</th><th /></tr></thead>
          <tbody>{rules.data!.map((r) => <tr key={r.id} className="border-t border-[#E5E5E0]"><td className="py-1.5 font-semibold">{r.name}</td><td>{label(r.event)}</td><td>{r.roles.map((x) => ROLES.find((y) => y[0] === x)?.[1] ?? x).join(', ')}</td><td>{r.channels.map((c) => c === 'INBOX' ? 'In the app' : c === 'EMAIL' ? 'Email' : 'SMS').join(', ')}</td>
            <td className="text-right">{canWrite && <button className="underline text-[#BC3F3F]" onClick={async () => { try { await api(`/channels/alert-rules/${r.id}`, { method: 'DELETE' }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); } }}>Remove</button>}</td></tr>)}</tbody></table>
      )}
      {canWrite && (
        <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Tell managers about schedules" /></Field>
            <Field label="When"><Select value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })} className="!w-auto"><option value="*">Anything happens</option>{(events.data ?? []).filter((e) => e.id !== 'webhook.ping').map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</Select></Field>
            <Btn variant="primary" disabled={f.name.trim().length < 2 || !f.roles.length || !f.channels.length} onClick={async () => { try { await api('/channels/alert-rules', { method: 'POST', body: f }); setF({ ...f, name: '' }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); } }}>Add rule</Btn>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]"><b>Tell:</b>{ROLES.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.roles.includes(k)} onChange={() => setF({ ...f, roles: toggle(f.roles, k) })} />{l}</label>)}</div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]"><b>By:</b>{[['INBOX', 'In the app'], ['EMAIL', 'Email'], ['SMS', 'SMS']].map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.channels.includes(k)} onChange={() => setF({ ...f, channels: toggle(f.channels, k) })} />{l}</label>)}</div>
        </div>
      )}
    </Card>
  );
};

/** The logo shown at the top of PDF reports. A small PNG or JPEG, kept with the organisation. */
const Branding: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [tick, setTick] = useState(0);
  const b = useApi<{ name: string; logo: string | null }>('/reports/branding', [tick]);
  const [err, setErr] = useState('');
  const save = async (logo: string | null) => { setErr(''); try { await api('/reports/branding', { method: 'PUT', body: { logo } }); setTick((n) => n + 1); } catch (e: any) { setErr(e.message); } };
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setErr('Choose a PNG or JPEG picture.'); return; }
    if (file.size > 200 * 1024) { setErr('That picture is too large. Use one under 200 KB.'); return; }
    const r = new FileReader();
    r.onload = () => void save(String(r.result));
    r.readAsDataURL(file);
  };
  return (
    <Card title="Logo on PDF reports" sub="Shown at the top of every PDF report, next to the organisation name. A small PNG or JPEG works best.">
      {err && <Banner kind="err" onClose={() => setErr('')}>{err}</Banner>}
      <div className="flex flex-wrap items-center gap-4">
        <div className="h-12 min-w-[120px] px-3 border border-[#E5E5E0] rounded-lg flex items-center gap-3 bg-white">
          {b.data?.logo ? <img src={b.data.logo} alt="Logo" className="max-h-9 max-w-[110px] object-contain" /> : <span className="text-[12px] text-[#6B6B6B]">No logo yet</span>}
          <span className="text-[13px] font-semibold">{b.data?.name}</span>
        </div>
        {canWrite && <label className="inline-flex"><input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /><span className="cursor-pointer px-3 py-1.5 rounded-md border border-[#E5E5E0] text-[13px] hover:bg-[#FAFAF8]">{b.data?.logo ? 'Change logo' : 'Upload logo'}</span></label>}
        {canWrite && b.data?.logo && <Btn onClick={() => save(null)}>Remove</Btn>}
      </div>
    </Card>
  );
};

const Reports: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const { groups } = useForecast();
  const [tick, setTick] = useState(0);
  const cat = useApi<{ reports: { id: string; label: string; help: string; pdf: boolean }[]; ranges: { id: string; label: string }[] }>('/reports/catalog');
  const list = useApi<Sched[]>('/reports/schedules', [tick]);
  const [open, setOpen] = useState<string | null>(null);
  const runs = useApi<SRun[]>(open ? `/reports/schedules/${open}/runs` : null, [open, tick]);
  const [f, setF] = useState({ name: '', report: 'ROSTER', groupId: '', range: 'NEXT_WEEK', frequency: 'WEEKLY', dayOfWeek: 4, dayOfMonth: 1, hour: 7, emails: '', roles: [] as string[], format: 'CSV' as 'CSV' | 'PDF' | 'BOTH' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setMsg(null); try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); setTick((n) => n + 1); } catch (e: any) { setMsg({ kind: 'err', text: e.message }); } };
  const pdfAllowed = cat.data?.reports.find((r) => r.id === f.report)?.pdf !== false;   // payroll stays CSV
  const format = pdfAllowed ? f.format : 'CSV';
  const create = () => act(() => api('/reports/schedules', { method: 'POST', body: { name: f.name, report: f.report, groupId: f.groupId || null, range: f.range, frequency: f.frequency, dayOfWeek: f.frequency === 'WEEKLY' ? f.dayOfWeek : null, dayOfMonth: f.frequency === 'MONTHLY' ? f.dayOfMonth : null, hour: f.hour, format, recipients: { emails: f.emails.split(/[\s,;]+/).filter(Boolean), roles: f.roles } } }).then(() => setF({ ...f, name: '', emails: '' })), 'Scheduled.');
  const describe = (s: Sched) => `${s.frequency === 'DAILY' ? 'Every day' : s.frequency === 'WEEKLY' ? `Every ${DAYS[s.dayOfWeek ?? 0]}` : `On day ${s.dayOfMonth} of the month`} at ${String(s.hour).padStart(2, '0')}:00 (${s.timezone}) · ${s.format === 'BOTH' ? 'CSV and PDF' : s.format}`;
  return (
    <div className="space-y-6">
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <Branding canWrite={canWrite} />
      <Card title="Scheduled reports" sub="A report is worked out on the day it runs, for dates such as “last week” or “next 7 days”, then emailed as a CSV file, a PDF, or both, and kept here. Email must be set up first.">
        {(list.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No scheduled reports yet.</p> : (
          <div className="space-y-2">{list.data!.map((s) => (
            <div key={s.id} className="border border-[#E5E5E0] rounded-lg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="font-semibold text-[13px]">{s.name}</span> {s.enabled ? <Pill tone="good">On</Pill> : <Pill tone="neutral">Off</Pill>}
                  <div className="text-[11px] text-[#6B6B6B]">{cat.data?.reports.find((r) => r.id === s.report)?.label} · {s.groupName ?? 'Everyone'} · {cat.data?.ranges.find((r) => r.id === s.range)?.label} · {describe(s)} · to {[...s.recipients.emails, ...s.recipients.roles.map((r) => ROLES.find((x) => x[0] === r)?.[1] ?? r)].join(', ')}</div>
                  <div className="text-[11px] text-[#6B6B6B]">Next {when(s.nextRunAt)} · last {when(s.lastRunAt)}</div></div>
                <div className="flex gap-3 text-[12px]">
                  <button className="underline" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide runs' : 'Past runs'}</button>
                  {canWrite && <button className="underline" onClick={() => act(() => api(`/reports/schedules/${s.id}/run-now`, { method: 'POST', body: {} }), 'Ran it now. The email is on its way.')}>Run now</button>}
                  {canWrite && <button className="underline" onClick={() => act(() => api(`/reports/schedules/${s.id}`, { method: 'PUT', body: { name: s.name, report: s.report, groupId: s.groupId, range: s.range, frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, hour: s.hour, timezone: s.timezone, recipients: s.recipients, enabled: !s.enabled, format: s.format } }))}>{s.enabled ? 'Switch off' : 'Switch on'}</button>}
                  {canWrite && <button className="underline text-[#BC3F3F]" onClick={() => confirm(`Delete “${s.name}”?`) && act(() => api(`/reports/schedules/${s.id}`, { method: 'DELETE' }))}>Delete</button>}
                </div>
              </div>
              {open === s.id && (runs.data ?? []).length > 0 && (
                <table className="w-full text-[11px] mt-2"><thead className="text-left text-[#6B6B6B]"><tr><th>When</th><th>Dates</th><th>Result</th><th>Sent to</th><th /></tr></thead>
                  <tbody>{runs.data!.map((r) => <tr key={r.id} className="border-t border-[#E5E5E0]"><td className="py-1">{when(r.ranAt)}</td><td>{r.from} to {r.to}</td><td><Pill tone={tone(r.status)}>{r.status === 'OK' ? `${r.rows} rows` : r.error ?? 'Failed'}</Pill></td><td>{r.sentTo}</td>
                    <td className="text-right space-x-3">{r.status === 'OK' && r.hasCsv && <button className="underline" onClick={() => download(`/reports/runs/${r.id}/download`, `${s.report.toLowerCase()}-${r.from}-to-${r.to}.csv`).catch((e) => setMsg({ kind: 'err', text: e.message }))}>CSV</button>}{r.status === 'OK' && r.hasPdf && <button className="underline" onClick={() => download(`/reports/runs/${r.id}/download?format=pdf`, `${s.report.toLowerCase()}-${r.from}-to-${r.to}.pdf`).catch((e) => setMsg({ kind: 'err', text: e.message }))}>PDF</button>}</td></tr>)}</tbody></table>
              )}
            </div>))}</div>
        )}
        {canWrite && (
          <div className="border-t border-[#E5E5E0] pt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Next week's roster" /></Field>
              <Field label="Report"><Select value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })} className="!w-auto">{(cat.data?.reports ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
              <Field label="For"><Select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })} className="!w-auto"><option value="">Everyone</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
              <Field label="Dates"><Select value={f.range} onChange={(e) => setF({ ...f, range: e.target.value })} className="!w-auto">{(cat.data?.ranges ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
              <Field label="Send as" hint={pdfAllowed ? undefined : 'Payroll is CSV only'}><Select value={format} disabled={!pdfAllowed} onChange={(e) => setF({ ...f, format: e.target.value as 'CSV' | 'PDF' | 'BOTH' })} className="!w-auto"><option value="CSV">CSV file</option><option value="PDF">PDF</option><option value="BOTH">CSV and PDF</option></Select></Field>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="How often"><Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })} className="!w-auto"><option value="DAILY">Every day</option><option value="WEEKLY">Every week</option><option value="MONTHLY">Every month</option></Select></Field>
              {f.frequency === 'WEEKLY' && <Field label="On"><Select value={f.dayOfWeek} onChange={(e) => setF({ ...f, dayOfWeek: Number(e.target.value) })} className="!w-auto">{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>}
              {f.frequency === 'MONTHLY' && <Field label="On day"><Input type="number" min={1} max={31} className="!w-20" value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })} /></Field>}
              <Field label="At (local hour)"><Select value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })} className="!w-auto">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
              <Field label="Email to (addresses, separated by commas)"><Input className="!w-80" value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} placeholder="boss@example.com" /></Field>
              <Btn variant="primary" disabled={f.name.trim().length < 2 || (!f.emails.trim() && !f.roles.length)} onClick={create}>Schedule it</Btn>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]"><b>Also email everyone who is:</b>{ROLES.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.roles.includes(k)} onChange={() => setF({ ...f, roles: f.roles.includes(k) ? f.roles.filter((x) => x !== k) : [...f.roles, k] })} />{l}</label>)}</div>
            <p className="text-[11px] text-[#6B6B6B]">{cat.data?.reports.find((r) => r.id === f.report)?.help}</p>
          </div>
        )}
      </Card>
    </div>
  );
};

const Sent: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [tick, setTick] = useState(0);
  const rows = useApi<Delivery[]>('/channels/deliveries', [tick]);
  return (
    <Card title="Sent messages" sub="The last hundred emails and texts. A message that fails is tried again with longer waits, then marked failed. Phone numbers are partly hidden.">
      <div><Btn onClick={() => setTick((n) => n + 1)}>Refresh</Btn></div>
      {(rows.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">Nothing sent yet.</p> : (
        <table className="w-full text-[12px]"><thead className="text-left text-[#6B6B6B]"><tr><th className="py-1">When</th><th>How</th><th>To</th><th>About</th><th>Result</th><th /></tr></thead>
          <tbody>{rows.data!.map((r) => <tr key={r.id} className="border-t border-[#E5E5E0]"><td className="py-1">{when(r.createdAt)}</td><td>{r.channel === 'EMAIL' ? 'Email' : 'SMS'}</td><td>{r.to}</td><td>{r.subject || (r.ref ?? '')}</td>
            <td><Pill tone={tone(r.status)}>{r.status === 'SENT' ? 'Sent' : r.status === 'PENDING' ? `Trying again (${r.attempts})${r.error ? `: ${r.error}` : ''}` : `Failed: ${r.error ?? ''}`}</Pill></td>
            <td>{canWrite && r.status === 'FAILED' && <button className="underline" onClick={async () => { await api(`/channels/deliveries/${r.id}/retry`, { method: 'POST', body: {} }).catch(() => {}); setTick((n) => n + 1); }}>Try again</button>}</td></tr>)}</tbody></table>
      )}
    </Card>
  );
};
