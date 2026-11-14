/**
 * Models (reference design). Two parts:
 *  - the leaderboard: every model is tested on weeks it has not seen (rolling 7-day-ahead forecasts over the last 4 weeks); a model
 *    is only chosen if it beats "same as last week";
 *  - self-learning: after real volume arrives the published forecast is compared with it, weekday corrections are learned and applied
 *    to new forecasts, and a drifted forecast gets a draft replacement for review.
 */
import { Waiting } from '../common/loading';
import React, { useState } from "react";
import { CartesianGrid, Line, LineChart as RLineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Award, CheckCircle2 } from "lucide-react";
import { api, dec, type Leaderboard, type Learning, type LearningRun, type RegistryRow, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "./hooks";
import { usePeriod } from "./usePeriod";
import { PERIOD_PRESETS, daysOf } from "../../services/periods";
import { Confirm } from "../configuration/groups/shared";
import { RowMenu } from "../workforce/TeamsExtras";
import { useAccuracyHeadline } from "./AccuracyHeadline";
import { ACCURACY_LABEL, accuracySub, accuracyTone, accuracyValue } from "../../services/accuracyTerms";
import { Busy } from "./ui";
import { ChartTooltip } from "./ChartTooltip";
import { Metric, OutlineButton, PrimaryButton, Section, Select } from "../wfm/app-shell";
import { Notice, RefScope, RefTable, Segmented } from "./RefScope";

const STAB = { HIGH: "bg-success-bg text-success", MEDIUM: "bg-warning-bg text-warning", VARIABLE: "bg-critical-bg text-critical" } as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ACTION: Record<LearningRun["action"], { label: string; cls: string }> = {
  NONE: { label: "No change", cls: "bg-surface-subtle text-muted-foreground" },
  CORRECTIONS_UPDATED: { label: "Corrections updated", cls: "bg-info-bg text-info" },
  DRAFT_CREATED: { label: "Draft prepared", cls: "bg-success-bg text-success" },
};
const signed = (f: number) => `${f > 1 ? "+" : ""}${Math.round((f - 1) * 100)}%`;

export function LeaderboardSection({ bare }: { bare?: boolean } = {}) {
  const { group, view, setView } = useForecast();
  const queueId = view?.queueId ?? "", setQueueId = (q: string) => setView({ queueId: q });      // the queue chosen on the Forecast Dashboard, kept between pages
  return (
    <RefScope bare={bare} crumb="Models" title="Models" description="Which forecasting method was most accurate on your history, and what the system has learned."
      toolbar={<QueueFilter queueId={queueId} setQueueId={setQueueId} />}>
      {(version) => <Body version={version} queueId={queueId} groupId={group!.id} />}
    </RefScope>
  );
}

function QueueFilter({ queueId, setQueueId }: { queueId: string; setQueueId: (q: string) => void }) {
  const { version } = useForecast();
  const board = useApi<Leaderboard>(version ? `/forecast/versions/${version.id}/leaderboard${queueId ? `?queueId=${queueId}` : ""}` : null, [version?.rev]);
  const series = (board.data?.series ?? []).filter((s) => s.queueId);
  if (series.length < 2) return null;
  const known = queueId === "" || series.some((s) => s.queueId === queueId);
  return <Select label="Queue" value={known ? queueId : ""} options={[{ id: "", label: "All queues (group total)" }, ...series.map((s) => ({ id: s.queueId!, label: s.name }))]} onChange={setQueueId} />;
}

function Body({ version, queueId, groupId }: { version: { id: string; kind: string; rev: number }; queueId: string; groupId: string }) {
  const { can, reload, go, setNotice } = useForecast();
  const [busy, setBusy] = useState("");
  const board = useApi<Leaderboard>(`/forecast/versions/${version.id}/leaderboard${queueId ? `?queueId=${queueId}` : ""}`, [version.rev]);
  const record = useApi<RegistryRow[]>(`/forecast/versions/${version.id}/registry`, [version.rev]);
  const mine = record.data?.find((r) => (queueId ? r.queueId === queueId : r.queueId === board.data?.queueId)) ?? null;

  const useModel = async (modelId: string, modelName: string) => {
    if (!confirm(`Create a new ${version.kind === "SHORT" ? "short-term" : "long-term"} forecast using "${modelName}"? Existing forecasts are kept.`)) return;
    setBusy(modelId); setNotice(null);
    try {
      const v = await api<{ id: string; name: string }>("/forecast/versions", { method: "POST", body: { groupId, kind: version.kind, model: modelId } });
      await reload(v.id);
      setNotice({ kind: "ok", text: `Created ${v.name}. It is a draft: review it, then submit it for approval.` });
      go("forecast-dashboard");
    } catch (e: any) { setNotice({ kind: "err", text: e.message }); } finally { setBusy(""); }
  };

  const rows = board.data?.rows ?? [];
  return (
    <>
      <Learn groupId={groupId} />
      <Section title={<span className="flex items-center gap-2"><Award className="size-4 text-warning" />Model leaderboard</span>}>
        <p className="max-w-4xl px-6 pb-3 text-[13px] text-muted-foreground">
          Each model forecast the last 4 weeks one week at a time, without seeing them. Ranked by how far off it was on average. The baseline, “same as last week”, is the bar every model has to beat.
        </p>
        {board.error && <Notice kind="err">{board.error}</Notice>}
        {board.loading && !board.data && <div className="px-6 pb-5"><Waiting what="the model comparison" shape="table" reload={board.reload} /></div>}
        {board.data && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 px-6 pb-3 text-[12px] text-muted-foreground">
              <span>Queue: <b className="text-foreground">{board.data.queueName}</b></span>
              {board.data.baselineWapePercent !== null && <span>Baseline test miss: <b className="text-foreground">{dec(board.data.baselineWapePercent, 1)}%</b></span>}
              {board.data.cleanedDays > 0 && <span>{board.data.cleanedDays} unusual day(s) were smoothed out before testing</span>}
              {mine && <span title={`Model record: ${mine.modelVersion}. It learned from ${mine.training.rows} days of history (${mine.training.from} to ${mine.training.to}); the fingerprint of those rows is ${mine.training.dataHash}. Made by ${mine.generatedBy ?? "the system"} on ${mine.generatedAt}.`}>Model record: <b className="text-foreground">{mine.modelVersion}</b> · trained on {mine.training.rows} days to {mine.training.to} · data {mine.training.dataHash.slice(0, 8)}</span>}
              {board.data.bands?.method && <span title="The band (P10 to P90) is made from the model's own errors on days it had not seen. Held back one week at a time, an actual should come in at or under P10 about 10% of the time and at or under P90 about 90% of the time.">Forecast band: <b className="text-foreground">{board.data.bands.method === 'EMPIRICAL' ? 'from its own past errors' : 'estimated (too little history)'}</b>{board.data.bands.p10Coverage >= 0 && <> · held {Math.round(board.data.bands.p10Coverage * 100)}% under P10, {Math.round(board.data.bands.p90Coverage * 100)}% under P90 when tested</>}</span>}
            </div>
            <RefTable right={[1, 2, 3, 4, 5]} head={["Model", "Test miss", "vs baseline", "Avg. error (contacts)", "Big misses", "Over / under", "Steadiness", ""]}>
              {rows.map((m) => (
                <tr key={m.modelId} className={`border-b ${m.isRecommended ? "bg-success-bg/40" : "hover:bg-surface"}`}>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${m.rank === 1 ? "bg-success text-white" : "bg-surface-subtle text-subtle-foreground"}`}>{m.rank}</span>
                      <div><div className="font-medium">{m.modelName}</div><div className="text-[12px] font-normal text-subtle-foreground">{m.recommendationReason}</div></div>
                    </div>
                  </td>
                  <td className="px-6 py-3 text-right font-semibold text-success">{dec(m.wapePercent, 1)}%{m.rawWapePercent != null && <div className="text-[11px] font-normal text-subtle-foreground" title="The same miss measured against what really came in, unusual days and events included, instead of the smoothed history the models learn from.">{dec(m.rawWapePercent, 1)}% on real volume</div>}</td>
                  <td className={`px-6 py-3 text-right ${m.vsBaselinePercent > 0 ? "text-success" : m.vsBaselinePercent < 0 ? "text-critical" : ""}`}>{m.modelId === "snaive" ? "—" : `${m.vsBaselinePercent > 0 ? "+" : ""}${dec(m.vsBaselinePercent, 0)}%`}</td>
                  <td className="px-6 py-3 text-right">{dec(m.mae, 1)}</td>
                  <td className="px-6 py-3 text-right">{dec(m.rmse, 1)}</td>
                  <td className="px-6 py-3 text-right">{Math.abs(m.biasPercent) < 0.05 ? "on target" : `${m.biasPercent > 0 ? "over" : "under"} ${dec(Math.abs(m.biasPercent), 1)}%`}</td>
                  <td className="px-6 py-3"><span className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${STAB[m.stabilityScore]}`}>{m.stability}</span></td>
                  <td className="whitespace-nowrap px-6 py-3 text-right">
                    {m.isRecommended
                      ? <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-success"><CheckCircle2 className="size-3.5" />In use</span>
                      : can("forecast:create") && <OutlineButton disabled={!!busy} onClick={() => useModel(m.modelId, m.modelName)}>{busy === m.modelId ? "Creating…" : "Forecast with this"}</OutlineButton>}
                  </td>
                </tr>
              ))}
            </RefTable>
            <p className="max-w-4xl px-6 py-3 text-[12px] text-subtle-foreground">
              Test miss: how far off the forecast was when each method was tested on your history, as a share of volume (lower is better). It is a test, not how the published forecasts did: that is Forecast accuracy. The figure in bold is against the smoothed history the models learn from; the small one under it is against what really came in, unusual days included. Big misses: like average error but punishes large mistakes more. Over / under: whether it tends to forecast too high or too low. {rows[0]?.backtestPeriod}.
            </p>
            {board.data.notes.length > 0 && <ul className="list-disc space-y-1 px-11 pb-5 text-[13px] text-muted-foreground">{board.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </>
        )}
      </Section>
    </>
  );
}

/** The self-learning part: how the published forecast did against real volume, what has been learned, and the history of looking. */
function Learn({ groupId }: { groupId: string }) {
  const { can, setNotice, go, setGroupId, groups } = useForecast();
  const [tick, setTick] = useState(0);
  const [weeks, setWeeks] = usePeriod();               // the same look-back choices, and the same remembered choice, as the accuracy trend on the Accuracy tab
  const days = daysOf(weeks);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetError, setForgetError] = useState("");
  const L = useApi<Learning>(`/forecast/learning?groupId=${groupId}&days=${days}`, [tick, days, groupId]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const d = L.data;
  const canEdit = can("forecast:create");

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setError("");
    try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };
  const learnNow = () => run("learn", async () => {
    const r = await api<LearningRun>("/forecast/learning/run", { method: "POST", body: { groupId } });
    setNotice({ kind: r.action === "NONE" ? "info" : "ok", text: r.note });
  });
  const setOn = (on: boolean) => run("switch", async () => { await api("/forecast/learning/settings", { method: "PUT", body: { groupId, enabled: on } }); });
  /** Forgetting is deleting: it asks for a reason and says what will change, and is only reached from the overflow menu. */
  const forgetNow = async (reason: string) => {
    setBusy("forget"); setForgetError("");
    try {
      const r = await api<{ cleared: number }>(`/forecast/learning/factors?groupId=${groupId}&reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
      setForgetOpen(false); setTick((t) => t + 1);
      setNotice({ kind: "ok", text: `Forgot ${r.cleared} learned correction${r.cleared === 1 ? "" : "s"}. New forecasts use the plain model output until it learns again.` });
    } catch (e: any) { setForgetError(e.message); } finally { setBusy(""); }
  };

  const ev = d?.evaluation;
  const hl = useAccuracyHeadline(groupId).data;
  const hlTone = accuracyTone(hl?.accuracyPct ?? null, hl?.targetPct);
  const active = (d?.factors ?? []).filter((f) => Math.abs(f.factor - 1) > 0.005).length;
  const missTone = ev?.wape == null ? "" : ev.wape > (d?.limits.wape ?? 0.15) ? "critical" as const : ev.wape > 0.1 ? "warning" as const : "success" as const;
  const byQueue = new Map<string, { name: string; f: Learning["factors"] }>();
  for (const f of d?.factors ?? []) { const q = byQueue.get(f.queueId) ?? { name: f.queueName, f: [] }; q.f.push(f); byQueue.set(f.queueId, q); }

  return (
    <Section title="Self-learning"
      action={canEdit && d && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={[{ id: "on", label: "Learning on" }, { id: "off", label: "Off" }]} value={d.enabled ? "on" : "off"} disabled={!!busy} onChange={(v) => setOn(v === "on")} />
          <PrimaryButton onClick={learnNow} disabled={!!busy}>{busy === "learn" ? "Learning…" : "Learn now"}</PrimaryButton>
          <RowMenu label="More actions" items={d.factors.length ? [{ label: "Forget what was learned…", danger: true, onClick: () => { setForgetError(""); setForgetOpen(true); } }] : []} />
        </div>
      )}>
      <div className="max-w-4xl px-6 pb-4 text-[13px] text-muted-foreground">
        <p>The system checks how past forecasts missed and corrects for steady patterns, such as Mondays running higher than forecast.</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] underline">How it works</summary>
          <p className="mt-1">Every forecast is rebuilt from all history, so new data is always used. Once real volume arrives, the models check how the published forecast did, remember any steady miss and apply it to new forecasts. If the average miss drifts past {d ? Math.round(d.limits.wape * 100) : 15}%, a fresh draft is prepared for you to review. Nothing goes live without the normal submit, approve and publish steps.</p>
        </details>
      </div>
      {error && <Notice kind="err" onClose={() => setError("")}>{error}</Notice>}
      {L.loading && !d && <div className="px-6 pb-5"><Waiting what="what the forecast has learned" shape="table" reload={L.reload} /></div>}
      {L.error && <Notice kind="err">{L.error}</Notice>}
      {d && ev && (
        <>
          {ev.wape == null && ev.bias == null ? (
            <div className="mx-6 mb-4 rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
              <div className="font-semibold text-foreground">No comparison yet</div>
              Once real volume arrives for a published forecast, this shows how accurate it was, whether it ran too high or low, and the adjustments the system makes.
            </div>
          ) : null}
          <div className={`${ev.wape == null && ev.bias == null ? 'hidden' : ''} grid grid-cols-2 divide-x divide-y border-y md:grid-cols-4 md:divide-y-0`}>
            <Metric label="Learning" value={d.enabled ? "On" : "Off"} hint={d.enabled ? "Applied to new forecasts" : "New forecasts use the plain model output"} tone={d.enabled ? undefined : "warning"} delta={d.enabled ? undefined : "Switched off"} />
            <Metric label={ACCURACY_LABEL} title={hl?.definition} value={accuracyValue(hl ?? null)} tone={hlTone === "good" ? "success" : hlTone === "warn" ? "warning" : hlTone === "bad" ? "critical" : undefined}
              delta={ev.drift ? "Drifted: a review is due" : undefined} hint={hl ? accuracySub(hl) : undefined} />
            <Metric label="Running too high or low" value={ev.bias == null ? "–" : Math.abs(ev.bias) < 0.005 ? "On target" : `${ev.bias > 0 ? "Over" : "Under"} ${(Math.abs(ev.bias) * 100).toFixed(1)}%`} hint={`${ev.days} day${ev.days === 1 ? "" : "s"} compared`} />
            <Metric label="Adjustments applied" value={String(active)} hint="Weekday corrections the system adds to new forecasts" />
          </div>

          {byQueue.size > 0 ? (
            <>
              <h3 className="px-6 pb-2 pt-5 text-[13px] font-semibold">What it has learned</h3>
              <RefTable right={[1, 2, 3, 4, 5, 6, 7]} head={["Queue", ...DAYS]}>
                {[...byQueue.values()].map((q) => (
                  <tr key={q.name} className="border-b">
                    <td className="px-6 py-3 font-medium">{q.name}</td>
                    {DAYS.map((_, i) => {
                      const f = q.f.find((x) => x.dow === i);
                      return (
                        <td key={i} className={`px-6 py-3 text-right ${!f || Math.abs(f.factor - 1) <= 0.005 ? "text-subtle-foreground" : f.factor > 1 ? "text-critical" : "text-info"}`}
                          title={f ? `${f.samples} day${f.samples === 1 ? "" : "s"} of evidence` : "Not enough evidence yet"}>{f ? signed(f.factor) : "–"}</td>
                      );
                    })}
                  </tr>
                ))}
              </RefTable>
              <p className="px-6 pb-4 pt-2 text-[12px] text-subtle-foreground">A plus means real volume ran above the forecast on that weekday, so new forecasts are raised by that much. Hover a figure for how many days it is based on.</p>
            </>
          ) : (
            <p className="px-6 py-4 text-[13px] text-subtle-foreground">Nothing learned yet. It needs at least {d.limits.minSamples} days of each weekday where a published forecast can be compared with real volume.</p>
          )}

          <div className="flex items-center justify-between px-6 pb-2 pt-5">
            <h3 className="text-[13px] font-semibold">Accuracy trend</h3>
            <Segmented options={PERIOD_PRESETS.map((p) => ({ id: String(p.weeks), label: p.label }))} value={String(weeks)} onChange={(v) => setWeeks(Number(v))} />
          </div>
          <AccuracyTrend runs={d.runs} limitPct={d.limits.wape * 100} days={days} />

          <h3 className="px-6 pb-2 pt-3 text-[13px] font-semibold">History</h3>
          {d.runs.length === 0 ? <p className="px-6 pb-5 text-[13px] text-subtle-foreground">It has not looked yet. It checks automatically whenever new call history is imported or fed in, and whenever you press Learn now.</p> : (
            <RefTable right={[2, 3]} head={["When", "Started by", "Days compared", "28-day miss", "Outcome", "What happened"]}>
              {d.runs.map((r) => (
                <tr key={r.id} className="border-b align-top">
                  <td className="whitespace-nowrap px-6 py-3">{when(r.at)}</td>
                  <td className="px-6 py-3 text-muted-foreground">{r.trigger === "DATA" ? "New data" : r.trigger === "SCHEDULE" ? "Daily check" : "Manual"}</td>
                  <td className="px-6 py-3 text-right">{r.days}</td>
                  <td className="px-6 py-3 text-right">{r.wape == null ? "–" : `${(r.wape * 100).toFixed(1)}%`}</td>
                  <td className="px-6 py-3"><span className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${ACTION[r.action].cls}`}>{ACTION[r.action].label}</span></td>
                  <td className="max-w-xl px-6 py-3 text-[12px] text-muted-foreground">
                    {r.note}
                    {r.versionId && <> <button className="underline" onClick={() => { setGroupId(groupId, r.versionId!); go("forecast-dashboard"); }}>Open the draft</button></>}
                  </td>
                </tr>
              ))}
            </RefTable>
          )}
        </>
      )}
      {forgetOpen && d && (() => {
        const live = d.factors.filter((f) => Math.abs(f.factor - 1) > 0.005);
        const queues = new Set(live.map((f) => f.queueId)).size;
        const top = [...live].sort((x, y) => Math.abs(y.factor - 1) - Math.abs(x.factor - 1)).slice(0, 3).map((f) => `${f.queueName} ${DAYS[f.dow]} ${signed(f.factor)}`);
        const name = groups.find((g) => g.id === groupId)?.name ?? "this group";
        return (
          <Confirm title={`Forget what was learned for ${name}?`} confirmLabel="Forget corrections" danger reason busy={busy === "forget"} error={forgetError} onCancel={() => setForgetOpen(false)} onConfirm={(why) => void forgetNow(why)}>
            <p><b>{live.length}</b> weekday correction{live.length === 1 ? "" : "s"} across {queues} queue{queues === 1 ? "" : "s"} will be deleted{top.length ? `, for example ${top.join(", ")}` : ""}.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>New forecasts go back to the plain model output until it learns again.</li>
              <li>Forecasts already made keep their numbers, and nothing in a published schedule changes.</li>
              <li>It starts learning again at the next import{d.enabled ? "" : " (not while Learning is off)"} or when you press Learn now, but needs at least {d.limits.minSamples} days of each weekday first.</li>
              <li><b>This cannot be undone.</b></li>
            </ul>
            <p>To stop it adding new corrections without deleting these, switch Learning off instead.</p>
          </Confirm>
        );
      })()}
    </Section>
  );
}

/** How the average miss (WAPE) has moved over the runs the group has actually had, not a fixed sample: bursty import schedules mean the runs are not evenly spaced, so the x-axis is the date it looked, not a run count. */
function AccuracyTrend({ runs, limitPct, days }: { runs: LearningRun[]; limitPct: number; days: number }) {
  const points = [...runs].filter((r) => r.wape !== null).sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((r) => ({ date: r.at.slice(0, 10), label: new Date(r.at).toLocaleDateString("en", { month: "short", day: "numeric" }), wapePct: Math.round(r.wape! * 1000) / 10, biasPct: r.bias === null ? null : Math.round(r.bias * 1000) / 10, drift: r.drift }));
  if (points.length < 2) {
    return (
      <div className="mx-6 mb-5 rounded-lg border border-dashed p-4">
        <svg viewBox="0 0 400 90" className="h-24 w-full text-border" role="img" aria-label="Empty chart: the average miss over time will appear here">
          {[15, 45, 75].map((y) => <line key={y} x1="30" x2="395" y1={y} y2={y} stroke="currentColor" strokeDasharray="3 4" />)}
          <line x1="30" x2="30" y1="5" y2="85" stroke="currentColor" />
          <text x="2" y="19" fontSize="9" fill="currentColor">15%</text><text x="6" y="49" fontSize="9" fill="currentColor">8%</text><text x="10" y="79" fontSize="9" fill="currentColor">0%</text>
        </svg>
        <p className="text-[13px] text-subtle-foreground">The average miss over time will chart here. It needs at least two checks in the last {days} days, spread over time.</p>
      </div>
    );
  }
  const avg = points.reduce((s, p) => s + p.wapePct, 0) / points.length;
  const worst = points.reduce((w, p) => (p.wapePct > w.wapePct ? p : w), points[0]);
  return (
    <>
      <div className="grid grid-cols-2 divide-x border-b md:grid-cols-4 md:divide-y-0">
        <Metric label={`Average 28-day miss, last ${days / 7} weeks`} value={`${dec(avg, 1)}%`} hint={`${points.length} checks, each the miss over the 28 days before it`} />
        <Metric label="Worst look" value={`${dec(worst.wapePct, 1)}%`} hint={worst.label} tone={worst.wapePct > limitPct ? "critical" : undefined} />
        <Metric label="Drift limit" value={`${dec(limitPct, 0)}%`} hint="A fresh draft is prepared past this" />
        <Metric label="Times drifted" value={String(points.filter((p) => p.drift).length)} hint={`of ${points.length} looks`} />
      </div>
      <div className="h-56 px-4 pb-6 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} fontSize={12} width={40} unit="%" />
            <Tooltip content={<ChartTooltip />} />
            <ReferenceLine y={limitPct} stroke="var(--color-critical)" strokeDasharray="4 4" label={{ value: "Drift limit", position: "insideTopRight", fontSize: 11, fill: "var(--color-critical)" }} />
            <Line dataKey="wapePct" name="28-day miss" stroke="var(--color-chart-2)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            <Line dataKey="biasPct" name="Over / under" stroke="var(--color-muted-foreground)" strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          </RLineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
