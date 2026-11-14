/**
 * Staffing › Pooling benefit. Two or more groups planned separately each carry their own safety margin. If their people can be shared (cross-trained), one pool serves the combined
 * traffic with fewer people. This works both out with the same engine, for one day, so the value of cross-training is a number.
 * The picker lists only groups that can be compared on the day (those with a published short-term forecast for it), searchable, with quick picks for a whole site or a pair that already
 * shares people; the answer is worked out by itself as groups are picked and is said in one sentence before the numbers.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { X } from "lucide-react";
import { api, dec } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { MAX_POOL, channelWords, headline, pickMany, search, siteChoices, split, suggestions, toggle, whyNot, type Cand, type Pair } from "../../services/poolingPicker";
import { useApi } from "./hooks";
import { Busy } from "./ui";
import { ChartTooltip } from "./ChartTooltip";
import { Metric, Section } from "../wfm/app-shell";
import { Notice, fieldCls } from "./RefScope";

type Result = {
  day: string; groups: { id: string; name: string; queues: number; contacts: number }[]; separateHours: number; pooledHours: number; savingHours: number; savingPercent: number; peakSeparate: number; peakPooled: number;
  targets: { serviceLevel: number; answerSec: number; from: string }; note: string; slots: { slot: number; time: string; separate: number; pooled: number }[];
};
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function PoolingSection() {
  const { groups } = useForecast();
  const [picked, setPicked] = useState<string[]>([]);
  const [day, setDay] = useState(tomorrow());
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<{ ids: string; data: Result } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [full, setFull] = useState(false);
  const cands = useApi<{ groups: Cand[]; sharedPairs: Pair[] }>(`/forecast/pooling/candidates?day=${day}`, [day]);
  const seq = useRef(0);
  const all = cands.data?.groups ?? [];
  const { ready, notReady } = useMemo(() => split(all), [all]);
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);
  const shownReady = useMemo(() => search(ready, query), [ready, query]);
  const shownNot = useMemo(() => search(notReady, query), [notReady, query]);
  const sites = useMemo(() => siteChoices(ready), [ready]);
  const ideas = useMemo(() => suggestions(ready, cands.data?.sharedPairs ?? []), [ready, cands.data]);
  const key = picked.join(",");

  // a group that has no forecast on a newly chosen day cannot stay picked
  useEffect(() => { if (cands.data) setPicked((p) => { const ok = p.filter((id) => byId.get(id)?.ready); return ok.length === p.length ? p : ok; }); }, [cands.data]);       // eslint-disable-line react-hooks/exhaustive-deps
  // the answer is worked out by itself a moment after the picks change
  useEffect(() => {
    if (picked.length < 2) { setRes(null); setBusy(false); return undefined; }
    const mine = ++seq.current;
    setBusy(true); setError("");
    const t = setTimeout(async () => {
      try { const data = await api<Result>(`/forecast/pooling?groupIds=${key}&day=${day}`); if (mine === seq.current) setRes({ ids: key, data }); }
      catch (e: any) { if (mine === seq.current) { setError(e.message); setRes(null); } }
      finally { if (mine === seq.current) setBusy(false); }
    }, 600);
    return () => clearTimeout(t);
  }, [key, day]);                                                                 // eslint-disable-line react-hooks/exhaustive-deps
  if (groups.length < 2) return null;

  const flip = (id: string) => { const r = toggle(picked, id); setPicked(r.picked); setFull(r.full); };
  const nameOf = (id: string) => byId.get(id)?.name ?? "group";
  const shown = res && res.ids === key ? res.data : null;
  const why = whyNot(picked.length);

  return (
    <Section title="Pooling benefit" action={
      <label className="flex items-center gap-2 text-[13px] text-muted-foreground">Day
        <input type="date" value={day} onChange={(e) => { setDay(e.target.value); setRes(null); }} aria-label="Day" className="h-9 rounded-lg border bg-background px-3 text-[13px] text-foreground" /></label>}>
      <p className="max-w-4xl px-6 pb-3 text-[13px] text-muted-foreground">Pick two or more groups whose people could share one pool. The answer appears as soon as two are picked.</p>

      <div className="mx-6 mb-4 max-w-4xl space-y-3 rounded-lg border p-4" data-testid="pool-picker">
        {/* what is picked */}
        <div className="flex flex-wrap items-center gap-2" data-testid="pool-selected" aria-live="polite">
          <span className="text-[12px] font-medium text-subtle-foreground">Picked {picked.length} of {MAX_POOL}</span>
          {picked.length === 0 && <span className="text-[13px] text-muted-foreground">No groups yet.</span>}
          {picked.map((id) => (
            <span key={id} className="inline-flex h-7 items-center gap-1 rounded-full bg-surface pl-3 pr-1.5 text-[13px] font-medium">{nameOf(id)}
              <button type="button" aria-label={`Remove ${nameOf(id)}`} className="rounded-full p-0.5 text-subtle-foreground hover:text-critical" onClick={() => flip(id)}><X className="size-3.5" /></button></span>))}
          {picked.length > 0 && <button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => { setPicked([]); setFull(false); }}>Clear</button>}
          {full && <span className="text-[12px] text-critical" role="alert">Up to {MAX_POOL} groups can be compared at once.</span>}
        </div>

        {/* quick picks */}
        {(sites.length > 0 || ideas.length > 0) && (
          <div className="flex flex-wrap items-center gap-2" data-testid="pool-quick">
            <span className="text-[12px] text-subtle-foreground">Quick picks</span>
            {ideas.map((s) => <button key={s.ids.join()} type="button" data-testid="pool-idea" className="h-8 rounded-full border bg-background px-3 text-[13px] hover:bg-surface" title={`${s.people} ${s.people === 1 ? "person works" : "people work"} in both`} onClick={() => { setPicked((p) => pickMany(p, s.ids)); setFull(false); }}>{s.label} <span className="text-muted-foreground">· share {s.people}</span></button>)}
            {sites.slice(0, 6).map((s) => <button key={s.siteId} type="button" data-testid="pool-site" className="h-8 rounded-full border bg-background px-3 text-[13px] hover:bg-surface" title={s.more ? `${s.more} more at this site are not included` : undefined} onClick={() => { setPicked((p) => pickMany(p, s.ids)); setFull(false); }}>All at {s.name} <span className="text-muted-foreground">· {s.ids.length}</span></button>)}
          </div>)}

        {/* search and the groups that can be compared */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <input type="search" aria-label="Search groups" placeholder="Search by name, site or channel" value={query} onChange={(e) => setQuery(e.target.value)} className={`${fieldCls} max-w-sm`} />
            <span className="text-[12px] text-muted-foreground" data-testid="pool-count">{cands.loading && !cands.data ? "Looking for groups…" : `${ready.length} of ${all.length} groups can be compared on ${day}`}</span>
          </div>
          <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border" data-testid="pool-list" aria-label="Groups that can be compared">
            {shownReady.map((c) => (
              <li key={c.id}>
                <label className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-surface ${picked.includes(c.id) ? "bg-surface" : ""}`}>
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={() => flip(c.id)} />
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-auto text-[12px] text-muted-foreground">{[c.siteName, channelWords(c.channels), `${c.people} ${c.people === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}</span>
                </label>
              </li>))}
            {!shownReady.length && <li className="px-3 py-3 text-[13px] text-muted-foreground">{ready.length ? "No group matches that search." : "No group has a published short-term forecast for this day."}</li>}
          </ul>
          {shownNot.length > 0 && (
            <details data-testid="pool-unavailable" className="text-[12px] text-muted-foreground">
              <summary className="cursor-pointer">{shownNot.length} {shownNot.length === 1 ? "group" : "groups"} can't be compared on this day: no published short-term forecast covers it</summary>
              <p className="mt-1 leading-relaxed">{shownNot.map((c) => c.name).join(", ")}</p>
            </details>)}
        </div>
      </div>

      {why && !busy && <p className="px-6 pb-4 text-[13px] text-muted-foreground" data-testid="pool-why">{why}</p>}
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}
      {busy && <div className="px-6 pb-5"><Busy text="Working out both ways…" /></div>}
      {shown && (
        <div className={busy ? "opacity-70" : ""}>
          <p className="mx-6 mb-4 max-w-4xl rounded-lg bg-surface px-4 py-3 text-[14px] font-medium" data-testid="pool-headline" aria-live="polite">{headline(shown)}</p>
          <div className="grid grid-cols-2 divide-x divide-y border-y md:grid-cols-4 md:divide-y-0">
            <Metric label="Separate pools" value={`${dec(shown.separateHours, 0)} h`} hint={`Peak ${Math.round(shown.peakSeparate)} people`} />
            <Metric label="One shared pool" value={`${dec(shown.pooledHours, 0)} h`} hint={`Peak ${Math.round(shown.peakPooled)} people`} />
            <Metric label="Saving" value={`${dec(shown.savingHours, 0)} h`} tone={shown.savingHours > 0 ? "success" : undefined} delta={shown.savingHours > 0 ? "Fewer people for the same service" : "No gain on this day"} />
            <Metric label="Saving, share" value={`${dec(shown.savingPercent, 1)}%`} hint={`Target ${Math.round(shown.targets.serviceLevel * 100)}% in ${shown.targets.answerSec}s (${shown.targets.from})`} />
          </div>
          <div className="h-64 px-4 py-4">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={shown.slots} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={12} interval={7} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={40} />
                <Tooltip content={<ChartTooltip />} />
                <Area dataKey="separate" name="Separate" stroke="var(--color-critical)" fill="var(--color-critical-bg)" strokeWidth={2} type="stepAfter" isAnimationActive={false} />
                <Line dataKey="pooled" name="Pooled" stroke="var(--color-chart-2)" strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="max-w-4xl px-6 pb-5 text-[12px] text-subtle-foreground">{shown.note}</p>
        </div>)}
    </Section>
  );
}
