/**
 * Configuration › RTA State Mapping. Tells the platform what each state from the phone / ACD system means as a WFM activity,
 * so a person's actual state can be compared with their scheduled activity (the same idea as "Map ACD events to activities"
 * in NICE, Verint/Calabrio and Genesys). A state can be matched with a reason code, or on its own for any reason.
 */
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Activity, api, ACTIVITY_CATEGORY_LABEL, StateMapping } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';

type Form = { id: string | null; state: string; reason: string; activityId: string };   // activityId '' = not working
const blank = (): Form => ({ id: null, state: '', reason: '', activityId: '' });
const COMMON = ['Available', 'On call', 'After-call work', 'Not Ready', 'On hold', 'Logged Out'];

export const RtaMappingPanel: React.FC = () => {
  const { can, setNotice } = useForecast();
  const [tick, setTick] = useState(0);
  const map = useApi<StateMapping[]>('/intraday/state-map', [tick]);
  const acts = useApi<Activity[]>('/config/activities');
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const w = can('config:write');

  const save = async () => {
    if (!f) return; setError('');
    const body = { state: f.state, reason: f.reason, activityId: f.activityId || null };
    try { if (f.id) await api(`/intraday/state-map/${f.id}`, { method: 'PUT', body }); else await api('/intraday/state-map', { method: 'POST', body }); setF(null); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); }
  };
  const del = async (m: StateMapping) => {
    if (!confirm(`Remove the mapping for “${m.state}${m.reason ? ` / ${m.reason}` : ''}”?`)) return;
    try { await api(`/intraday/state-map/${m.id}`, { method: 'DELETE' }); setTick((t) => t + 1); } catch (e: any) { setNotice({ kind: 'err', text: e.message }); }
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => s && { ...s, [k]: v });
  const none = (acts.data?.length ?? 0) === 0;

  return (
    <Card title="RTA state mapping" sub="Say what each state your phone system reports means as an activity. Real-time adherence compares that activity with what the schedule says the person should be doing. A mapping with a reason code wins over the same state without one."
      actions={w && <Btn variant="primary" disabled={none} onClick={() => { setError(''); setF(blank()); }}><Plus className="w-3.5 h-3.5" />Add mapping</Btn>}>
      {none && <Banner kind="info">Define your activities first (Configuration › Activity Definitions), then map states to them here.</Banner>}
      {f && (
        <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="State from the phone system" hint="Exactly as it sends it, for example Available or Not Ready">
              <Input list="rta-common" value={f.state} onChange={(e) => set('state', e.target.value)} placeholder="e.g. Not Ready" />
              <datalist id="rta-common">{COMMON.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
            <Field label="Reason code (optional)" hint="Leave empty to match any reason"><Input value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Lunch" /></Field>
            <Field label="Counts as">
              <Select value={f.activityId} onChange={(e) => set('activityId', e.target.value)}>
                <option value="">Not working (logged out, unavailable)</option>
                {acts.data?.filter((a) => a.status === 'ACTIVE').map((a) => <option key={a.id} value={a.id}>{a.name} ({ACTIVITY_CATEGORY_LABEL[a.category]})</option>)}
              </Select>
            </Field>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          <div className="flex gap-2"><Btn variant="primary" disabled={!f.state.trim()} onClick={save}>Save mapping</Btn><Btn onClick={() => setF(null)}>Cancel</Btn></div>
        </div>
      )}
      {map.error && <Banner kind="err">{map.error}</Banner>}
      {map.data?.length === 0 && !f ? <Empty title="No state mappings yet">Add one for each state your phone system reports (Available, On call, Not Ready with each reason code, Logged Out). Until a state is mapped it shows as Unknown on the adherence screen.</Empty> : (
        <Table head={['State', 'Reason code', 'Counts as', '']}>
          {map.data?.map((m) => (
            <tr key={m.id}>
              <td className="p-3 font-semibold">{m.state}</td>
              <td className="p-3">{m.reason || <span className="text-[#737373]">Any</span>}</td>
              <td className="p-3">{m.activityId ? m.activityName : <Pill>Not working</Pill>}</td>
              <td className="p-3 text-right whitespace-nowrap">{w && <><button className="text-[12px] underline mr-3" onClick={() => { setError(''); setF({ id: m.id, state: m.state, reason: m.reason, activityId: m.activityId ?? '' }); }}>Edit</button><button aria-label="Remove mapping" className="text-[#737373] hover:text-[#C84A4A]" onClick={() => del(m)}><Trash2 className="w-4 h-4 inline" /></button></>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
};
