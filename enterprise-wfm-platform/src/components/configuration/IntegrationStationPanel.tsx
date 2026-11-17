/**
 * Configuration › Integration Station. Category, then provider, then that provider's real credential fields, all on
 * one page -- the pattern Segment's Sources Catalog and the embedded-iPaaS platforms (Workato, Paragon) use. Every
 * named provider is a preset of one of six generic delivery methods; "Generic" in any category is the answer to a
 * custom or proprietary system -- either its own REST API (configure the mapping, no code from us) or a closed
 * system (we issue an API key; the customer's own team's connector posts to our documented ingest endpoint).
 */
import { Waiting, LoadFailed } from '../common/loading';
import React, { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { api, Connector, ConnectorCreated, EntitySuggestion, EventRule, FeedEvent, FeedOutcome, IntegrationCatalog, IntegrationField, IntegrationFieldMap, IntegrationPreset, MapTestResult, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "../forecasting/hooks";
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from "../forecasting/ui";
import { describeSchedule, NO_SCHEDULE, ScheduleEditor, type ScheduleDraft } from "../data/ScheduleEditor";

const CATEGORIES = [
  { id: "ACD", label: "ACD (voice/chat volume, agent state)" }, { id: "CRM", label: "CRM (agent presence)" },
  { id: "HRMS", label: "HRMS (employee sync)" }, { id: "DATABASE", label: "Database (direct read)" },
  { id: "ONPREM", label: "On-prem ACD (custom/closed)" }, { id: "SFTP", label: "File / SFTP" },
] as const;

const statusTone = (s: string) => (s === "ACTIVE" ? "good" : s === "ERROR" ? "bad" : s === "PAUSED" ? "warn" : "neutral") as "good" | "bad" | "warn" | "neutral";

/** "2 min ago", for a time that matters because of how recent it is (the exact time stays in the tooltip). */
const agoText = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** A connection setting as a labelled row. Secrets arrive already masked from the server, so nothing here can reveal them. */
const CONFIG_LABEL: Record<string, string> = { subject: "Subject listened to", natsUser: "User name", natsPass: "Password", tlsRejectUnauthorized: "Server certificate" };
const configRow = (k: string, v: string): { label: string; value: string; warn?: string } =>
  k === "tlsRejectUnauthorized" ? (String(v) === "false" ? { label: CONFIG_LABEL[k], value: "Not checked", warn: "The connection does not verify the server's certificate, so it could be talking to an impostor. Fine on a private network, not over the internet." } : { label: CONFIG_LABEL[k], value: "Checked" })
    : { label: CONFIG_LABEL[k] ?? k, value: String(v) };

type DetailTab = "overview" | "live" | "runs" | "mapping" | "rules";

type TestStep = { name: string; status: "ok" | "warn" | "fail"; detail: string };
const STEP_MARK: Record<TestStep["status"], { icon: string; cls: string }> = { ok: { icon: "✓", cls: "text-[#2A7553]" }, warn: { icon: "!", cls: "text-[#8F6200]" }, fail: { icon: "✕", cls: "text-[#BC3F3F]" } };

/** Checks a live connector step by step on a connection of its own (the running feed is not touched, nothing is saved). */
const ConnectionTest: React.FC<{ connector: Connector; canWrite: boolean }> = ({ connector, canWrite }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ ok: boolean; steps: TestStep[] } | null>(null);
  useEffect(() => { setResult(null); setError(""); }, [connector.id]);
  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await api(`/integrations/${connector.id}/test-connection`, { method: "POST", timeoutMs: 45_000 })); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-[13px] font-semibold">Test the connection</div>
        <Btn disabled={!canWrite || busy} onClick={run} title={canWrite ? undefined : "You need permission to change configuration"}>{busy ? "Testing…" : "Test connection"}</Btn>
        {busy && <span className="text-[12px] text-[#6B6B6B]">Listening for about 8 seconds to see whether messages arrive.</span>}
      </div>
      <p className="text-[12px] text-[#6B6B6B]">Opens a separate connection with these settings. It does not disturb the live feed and nothing is saved.</p>
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      {result && (
        <ul className={`rounded-lg border divide-y text-[13px] ${result.ok ? "border-[#2F7D5A]/30" : "border-[#E9D9B4]"}`} aria-live="polite">
          {result.steps.map((s) => (
            <li key={s.name} className="flex gap-3 px-3 py-2">
              <span aria-label={s.status} className={`w-4 shrink-0 font-bold ${STEP_MARK[s.status].cls}`}>{STEP_MARK[s.status].icon}</span>
              <div><div className="font-semibold">{s.name}</div><div className="text-[12px] text-[#525252]">{s.detail}</div></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

type FeedView = { events: FeedEvent[]; lastHour: Record<FeedOutcome, number>; available: boolean };
const OUTCOME_LABEL: Record<FeedOutcome, string> = { ACCEPTED: "Accepted", REJECTED: "Not accepted", WAITING: "Waiting for a rule", IGNORED: "Ignored" };
const OUTCOME_TONE: Record<FeedOutcome, "good" | "bad" | "warn" | "neutral"> = { ACCEPTED: "good", REJECTED: "bad", WAITING: "warn", IGNORED: "neutral" };
const SILENT_MIN = 5;           // a live feed that has sent nothing for this long is called quiet

/** The messages a live connector has received in the last day and what became of each, so a feed that "connects but shows nothing" can be explained. */
const LiveEvents: React.FC<{ connector: Connector }> = ({ connector }) => {
  const [outcome, setOutcome] = useState<"" | "ACCEPTED" | "REJECTED" | "WAITING">("");
  const [paused, setPaused] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const feed = useApi<FeedView>(`/integrations/${connector.id}/events${outcome ? `?outcome=${outcome}` : ""}`, [connector.id, outcome]);
  const reload = feed.reload;
  useEffect(() => { if (paused) return; const t = setInterval(reload, 5000); return () => clearInterval(t); }, [paused, reload]);
  const d = feed.data;
  const quietMin = connector.status === "ACTIVE" && connector.lastReceivedAt ? Math.floor((Date.now() - new Date(connector.lastReceivedAt).getTime()) / 60000) : 0;
  const tiles: FeedOutcome[] = ["ACCEPTED", "REJECTED", "WAITING", "IGNORED"];
  return (
    <div className="space-y-3">
      {quietMin >= SILENT_MIN && <Banner kind="warn">Nothing has arrived for {quietMin} minutes. Check that the phone system is sending to this subject.</Banner>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((o) => <Tile key={o} label={`${OUTCOME_LABEL[o]}, last hour`} value={d ? d.lastHour[o].toLocaleString() : "–"} tone={o === "ACCEPTED" && d && d.lastHour[o] > 0 ? "good" : "neutral"} note={o === "IGNORED" ? "heartbeats and other types set to be ignored" : undefined} />)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {([["", "All"], ["REJECTED", "Not accepted"], ["WAITING", "Waiting for a rule"], ["ACCEPTED", "Accepted"]] as const).map(([v, l]) => (
          <button key={v} type="button" onClick={() => { setOutcome(v); setOpen(null); }} aria-pressed={outcome === v}
            className={`rounded-md border px-2.5 py-1 text-[12px] ${outcome === v ? "border-[#171717] bg-[#FAFAF8] font-semibold" : "border-[#E5E5E0] text-[#6B6B6B] hover:bg-[#FAFAF8]"}`}>{l}</button>
        ))}
        <span className="flex-1" />
        <span className="text-[11px] text-[#6B6B6B]">{paused ? "Paused" : feed.refreshing ? "Updating…" : "Updates every 5 seconds"}</span>
        <Btn onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</Btn>
        <Btn onClick={reload}>Refresh</Btn>
      </div>
      {feed.error && !d && <Banner kind="err">{feed.error}</Banner>}
      {d && !d.available && <Banner kind="warn">The recent-events store is not available right now, so this list is empty. The feed itself keeps working.</Banner>}
      {d && d.available && d.events.length === 0 && <p className="text-[12px] text-[#6B6B6B]">{outcome ? "Nothing here for that filter." : "No events yet. Messages appear here as they arrive, newest first and kept for a day; heartbeats are only counted above."}</p>}
      {d && d.events.length > 0 && (
        <Table head={["Received", "Agent id", "Event type", "State", "Result", "Why"]}>
          {d.events.map((e, i) => (
            <React.Fragment key={`${e.at}-${i}`}>
              <tr className="cursor-pointer hover:bg-[#FAFAF8]" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <td className="p-3 whitespace-nowrap" title={new Date(e.at).toLocaleString()}>{agoText(e.at)}</td>
                <td className="p-3 font-mono text-[12px]">{e.sourceId ?? "–"}</td>
                <td className="p-3 font-mono text-[12px]">{e.eventType ?? "–"}</td>
                <td className="p-3">{e.state ? <>{e.state}{e.reason ? <span className="text-[#6B6B6B]"> · {e.reason}</span> : null}</> : "–"}</td>
                <td className="p-3"><Pill tone={OUTCOME_TONE[e.outcome]}>{OUTCOME_LABEL[e.outcome]}</Pill></td>
                <td className="p-3 text-[12px]">{e.message ?? ""}</td>
              </tr>
              {open === i && <tr><td colSpan={6} className="p-3 bg-[#FAFAF8]"><div className="text-[11px] text-[#6B6B6B] mb-1">Message as received</div><pre className="font-mono text-[11.5px] whitespace-pre-wrap break-all">{JSON.stringify(e.raw, null, 2)}</pre></td></tr>}
            </React.Fragment>
          ))}
        </Table>
      )}
    </div>
  );
};

/** One fact about a connector: a small label, a headline value and a quiet note under it. */
const Tile: React.FC<{ label: string; value: string; note?: string; tone?: "good" | "neutral" }> = ({ label, value, note, tone = "neutral" }) => (
  <div className="rounded-lg border border-[#E5E5E0] px-3 py-2.5">
    <div className="text-[11px] text-[#6B6B6B]">{label}</div>
    <div className={`text-[15px] font-semibold mt-0.5 ${tone === "good" ? "text-[#2A7553]" : "text-[#171717]"}`}>{value}</div>
    {note && <div className="text-[11px] text-[#6B6B6B] mt-0.5">{note}</div>}
  </div>
);

/** What the setup screen says about a provider: a short guide where there is one, otherwise the original note. */
const ProviderIntro: React.FC<{ preset: IntegrationPreset }> = ({ preset }) => {
  const g = preset.guide;
  return (
    <div className="border border-[#E5E5E0] rounded bg-[#FAFAF8] p-3 space-y-2 text-[12px] text-[#525252]">
      {preset.readiness && (preset.readiness.level === "NOT_READY" || preset.readiness.level === "FROM_DOCS") && <p className="text-[#6B6B6B]">{preset.readiness.note}</p>}
      {g ? (
        <>
          <p className="text-[#171717]">{g.what}</p>
          <div><div className="font-semibold text-[#171717]">Before you start</div><ul className="list-disc pl-5 space-y-0.5">{g.needs.map((n) => <li key={n}>{n}</li>)}</ul></div>
          {g.limits.length > 0 && <div className="rounded border border-[#B7791F]/20 bg-[#FFF5DD] text-[#8F6200] px-2.5 py-1.5"><div className="font-semibold">What it does not do yet</div><ul className="list-disc pl-5 space-y-0.5">{g.limits.map((n) => <li key={n}>{n}</li>)}</ul></div>}
        </>
      ) : preset.note ? <p>{preset.note}</p> : null}
    </div>
  );
};

/** The commands and steps to run right after a connector is created, with its id and key already filled in. Shown once, with the key. */
const NextSteps: React.FC<{ created: ConnectorCreated; preset?: IntegrationPreset }> = ({ created, preset }) => {
  const gateway = location.origin.replace(/:\d+$/, ":4000");
  const [copied, setCopied] = useState("");
  const copy = (id: string, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(""), 1500); }).catch(() => {}); };
  const block = (id: string, title: string, text: string) => (
    <div key={id}>
      <div className="flex items-center justify-between"><span className="font-semibold">{title}</span><button className="text-[11px] underline" onClick={() => copy(id, text)}>{copied === id ? "Copied" : "Copy"}</button></div>
      <pre className="font-mono text-[11.5px] bg-white/60 rounded px-2 py-1 whitespace-pre-wrap break-all select-all">{text}</pre>
    </div>
  );
  const key = created.apiKey ?? "<api key>";
  let body: React.ReactNode = null;
  if (created.preset === "AVAYA_AACC") {
    const conn = `--server <database host> --database <database name> --user <read-only user>`;
    const send = `--gateway ${gateway} --connector ${created.id} --key ${key}`;
    body = <>
      {block("a1", "1. On a machine inside your network", `cd integrations/avaya-aacc-connector && npm install
export AACC_SQL_PASSWORD=<read-only password>`)}
      {block("a2", "2. See the real column names in your table", `node index.mjs ${conn} --check-columns`)}
      {block("a3", "3. Load history (it waits for your review in Staged Ingestion)", `node index.mjs ${conn} ${send} --backfill-weeks 8`)}
      {block("a4", "4. Keep it up to date", `node index.mjs ${conn} ${send}`)}
    </>;
  } else if (preset?.method === "ONPREM_RELAY" || preset?.id === "GENERIC_DATABASE") {
    body = block("g1", "Send rows from your own connector", `curl -X POST ${gateway}/api/v1/integrations/${created.id}/live -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"rows":[{"queue":"Support","day":"2026-11-05","time":"09:00","volume":120}]}'`);
  } else if (preset?.method === "STREAM_SUBSCRIBE") {
    body = <ol className="list-decimal pl-5 space-y-0.5"><li>Set the connector to Active so it connects.</li><li>Open the connector and check the field mapping and event types once messages arrive.</li><li>Match each agent to an employee.</li></ol>;
  }
  if (!body) return null;
  return <div className="space-y-2 pt-2 border-t border-black/10 text-[12px]"><div className="font-semibold">What to do next</div>{body}</div>;
};

export const IntegrationStationPanel: React.FC<{ focusId?: string; onChange?: () => void; feeds?: boolean }> = ({ focusId, onChange, feeds }) => {
  const { groups, can } = useForecast();
  const canWrite = can("config:write");
  const [tick, setTick] = useState(0);
  const catalog = useApi<IntegrationCatalog>("/integrations/catalog");
  const connectors = useApi<Connector[]>("/integrations", [tick]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [justCreated, setJustCreated] = useState<ConnectorCreated | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (focusId) { setSelected(focusId); setCreating(false); } }, [focusId]);   // the Data Feeds table can open a connector here
  const [showDrafts, setShowDrafts] = useState(false);
  // the list and the connector sit side by side, so one is always open: the first one that is live, until another is picked
  useEffect(() => {
    const list = connectors.data;
    if (!creating && list?.length && !list.some((c) => c.id === selected)) setSelected((list.find((c) => c.status !== "DRAFT") ?? list[0]).id);
  }, [connectors.data, selected, creating]);

  const run = async (fn: () => Promise<void>) => { setError(""); try { await fn(); setTick((t) => t + 1); onChange?.(); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      {justCreated && (
        <Banner kind="ok" onClose={() => setJustCreated(null)}>
          <div className="space-y-1">
            <div className="font-semibold">"{justCreated.name}" created. {justCreated.apiKey ? "Save this API key now -- it will not be shown again." : "Save this webhook secret now -- it will not be shown again."}</div>
            {justCreated.apiKey && <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">{justCreated.apiKey}</div>}
            <NextSteps created={justCreated} preset={catalog.data ? Object.values(catalog.data).flat().find((p) => p.id === justCreated.preset) : undefined} />
            {justCreated.webhookSecret && <>
              <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">Secret: {justCreated.webhookSecret}</div>
              <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">URL: {location.origin.replace(/:\d+$/, ":4000")}{justCreated.webhookUrl}</div>
            </>}
          </div>
        </Banner>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        <Card title="Connectors" sub="Real, vendor-specific integrations -- ACD, CRM, HRMS, a database, an on-prem system or a scheduled file. Historical data lands in Staged Ingestion for review, exactly like a manual CSV upload; live data feeds interval history or RTA state directly."
          actions={canWrite && <Btn variant="primary" onClick={() => { setCreating((c) => !c); setSelected(""); }}><Plus className="w-3.5 h-3.5" />{creating ? "Close" : "New"}</Btn>}>
          {connectors.loading && !connectors.data ? <Waiting what="connectors" shape="table" reload={connectors.reload} /> : connectors.error && !connectors.data ? <LoadFailed what="connectors" error={connectors.error} reload={connectors.reload} /> : !connectors.data?.length ? (
            <Empty title="No connectors yet">Add one for the ACD, CRM or HRMS system you actually use, or a direct database read.</Empty>
          ) : (() => {
            const live = connectors.data.filter((c) => c.status !== "DRAFT"), drafts = connectors.data.filter((c) => c.status === "DRAFT");
            const open = showDrafts || drafts.some((c) => c.id === selected);
            const item = (c: Connector) => {
              const pr = catalog.data ? Object.values(catalog.data).flat().find((p) => p.id === c.preset) : undefined;
              const needs = c.status === "ACTIVE" && !!c.lastError;
              return (
                <button key={c.id} onClick={() => { setSelected(c.id); setCreating(false); }} aria-current={selected === c.id}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border ${selected === c.id ? "border-[#171717] bg-[#FAFAF8]" : "border-transparent hover:bg-[#FAFAF8]"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-[13px] leading-snug">{c.name}</span>
                    <Pill tone={needs ? "bad" : statusTone(c.status)}>{needs ? "Needs attention" : c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Pill>
                  </div>
                  <div className="text-[11px] text-[#6B6B6B] mt-0.5" title={c.lastReceivedAt ? when(c.lastReceivedAt) : undefined}>
                    {pr && pr.label !== c.name ? `${pr.label} · ` : ""}{c.lastReceivedAt ? `last data ${agoText(c.lastReceivedAt)}` : "no data yet"}{typeof c.rows24h === "number" ? ` · ${c.rows24h.toLocaleString()} in 24 h` : ""}
                  </div>
                  {c.lastError && <div className="text-[11px] text-[#BC3F3F] mt-1 line-clamp-2" title={c.lastError}>{c.lastError}</div>}
                </button>
              );
            };
            return (
              <div className="space-y-1 -mx-1">
                {live.map(item)}
                {drafts.length > 0 && (
                  <div className="pt-1">
                    <button type="button" className="w-full text-left px-3 py-1.5 text-[12px] text-[#6B6B6B] hover:text-[#171717]" aria-expanded={open} onClick={() => setShowDrafts((v) => !v)}>
                      {open ? "▾" : "▸"} Drafts ({drafts.length}) <span className="text-[11px]">not connected yet</span>
                    </button>
                    {open && drafts.map(item)}
                  </div>
                )}
              </div>
            );
          })()}
        </Card>

        <div className="min-w-0 space-y-4">
          {creating && catalog.data && <Card title="New connector"><NewConnectorForm feeds={feeds} catalog={catalog.data} groups={groups} onCreated={(c) => { setCreating(false); setJustCreated(c); setSelected(c.id); setTick((t) => t + 1); }} onError={setError} /></Card>}
          {!creating && selected && connectors.data?.find((c) => c.id === selected) && (
            <ConnectorDetail feeds={feeds} connector={connectors.data.find((c) => c.id === selected)!} catalog={catalog.data ?? null} canWrite={canWrite} onChanged={() => { setTick((t) => t + 1); onChange?.(); }} onDeleted={() => { setSelected(""); setTick((t) => t + 1); }} onError={setError} run={run} />
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- create

export const FieldInput: React.FC<{ f: IntegrationField; value: string; onChange: (v: string) => void }> = ({ f, value, onChange }) => {
  if (f.kind === "select") return <Select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>;
  if (f.kind === "textarea") return <textarea className="w-full p-2 border border-[#E5E5E0] rounded text-[12px] font-mono h-32" spellCheck={false} placeholder="SELECT queue, day, time, volume, ahtSec FROM ... WHERE day BETWEEN {from} AND {to}" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (f.kind === "file") return <textarea className="w-full p-2 border border-[#E5E5E0] rounded text-[12px] font-mono h-20" placeholder="Paste the file's contents" value={value} onChange={(e) => onChange(e.target.value)} />;
  return <Input type={f.kind === "password" ? "password" : "text"} value={value} onChange={(e) => onChange(e.target.value)} />;
};

const NewConnectorForm: React.FC<{ feeds?: boolean; catalog: IntegrationCatalog; groups: { id: string; name: string }[]; onCreated: (c: ConnectorCreated) => void; onError: (m: string) => void }> = ({ feeds, catalog, groups, onCreated, onError }) => {
  const [category, setCategory] = useState<string>("ACD");
  const presets = catalog[category] ?? [];
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "");
  useEffect(() => { setPresetId((catalog[category] ?? [])[0]?.id ?? ""); }, [category]);
  const preset = presets.find((p) => p.id === presetId) ?? (catalog[category] ?? [])[0];
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  useEffect(() => setConfig({}), [presetId]);
  const [busy, setBusy] = useState(false);
  const { session } = useForecast();
  const [schedule, setSchedule] = useState<ScheduleDraft>(NO_SCHEDULE);
  useEffect(() => setSchedule(NO_SCHEDULE), [presetId]);

  const create = async () => {
    setBusy(true);
    try {
      const c = await api<ConnectorCreated>("/integrations", { method: "POST", body: { category, preset: presetId, name: name || `${preset?.label} connector`, wfmGroupId: groupId || null, config, ...(feeds && preset?.canPull && (schedule.scheduleAt || schedule.scheduleMin) ? schedule : {}) } });
      onCreated(c);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="border border-[#E5E5E0] rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="Provider"><Select value={presetId} onChange={(e) => setPresetId(e.target.value)}>{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={preset ? `${preset.label} connector` : ""} /></Field>
        <Field label="WFM group" hint="blank = tenant-wide (HRMS/CRM)"><Select value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">All groups</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
      </div>
      {preset && <ProviderIntro preset={preset} />}
      {preset && preset.fields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {preset.fields.map((f) => (
            <Field key={f.key} label={f.label + (f.required ? " *" : "")} hint={f.help}>
              <FieldInput f={f} value={config[f.key] ?? ""} onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))} />
            </Field>
          ))}
        </div>
      )}
      {feeds && preset?.canPull && (
        <div className="space-y-1">
          <div className="text-[12px] font-semibold">When should we fetch it?</div>
          <ScheduleEditor value={schedule} onChange={setSchedule} timezone={session.tenant.timezone} />
          <p className="text-[12px] text-[#6B6B6B]">It starts running once the connector is set to Active.</p>
        </div>
      )}
      {preset && preset.fields.length === 0 && <p className="text-[12px] text-[#6B6B6B]">No credentials to enter -- we issue an API key on creation and your own connector script uses it.</p>}
      <Btn variant="primary" disabled={busy} onClick={create}>Create connector</Btn>
    </div>
  );
};

// ---------------------------------------------------------------- detail: field maps + entity matching

/** Known target fields per ingest destination -- what a dropped sample field can be mapped onto. Anything outside
 * this list (HRMS, a Generic preset's own shape) still goes through the manual rows editor below unchanged. */
const TARGET_FIELDS: Record<string, string[]> = {
  agent_state: ['employeeNumber', 'state', 'reason', 'at', 'eventType'],
  interval_history: ['queueId', 'queue', 'day', 'time', 'slot', 'volume', 'ahtSec', 'abandoned'],
};

/** Display names for the fixed target keys -- the key itself (e.g. "employeeNumber") is what the backend reads and
 * must never change, but most vendors' agent identifier is really an extension/SIP handle, not our employee_number,
 * so the on-screen label says what it actually is. Renaming the underlying key here would silently break ingest. */
const FIELD_LABEL: Record<string, string> = { employeeNumber: 'Agent extension', state: 'State', reason: 'Reason', at: 'Timestamp', eventType: 'Event type' };

/** Flattens a sample payload into draggable {path, value} leaves, e.g. {a:{b:1}} -> [{path:'a.b', value:1}]. Capped so one huge payload can't flood the picker. */
function flattenSample(obj: unknown, prefix = '', out: { path: string; value: string }[] = []): { path: string; value: string }[] {
  if (out.length >= 60) return out;
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') { if (prefix) out.push({ path: prefix, value: String(obj) }); return out; }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (out.length >= 60) break;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flattenSample(v, path, out);
    else out.push({ path, value: Array.isArray(v) ? JSON.stringify(v) : String(v) });
  }
  return out;
}


// ---------------------------------------------------------------- schedule, run now, run history

type RunRow = { startedAt: string; trigger: string; kind: string; status: string; rowsIn: number; rowsOk: number; rowsRejected: number; message: string | null };
type FileRow = { fileName: string; fileSize: number; status: string; importJobId: string | null; message: string | null; seenAt: string };
const TRIGGER_LABEL: Record<string, string> = { SCHEDULE: "Schedule", MANUAL: "Run now", PUSH: "Sent to us" };
const KIND_LABEL: Record<string, string> = { PULL: "Pulled", FILE: "File pick-up", LIVE: "Live rows", BACKFILL: "History backfill", WEBHOOK: "Webhook" };
const RUN_TONE: Record<string, "good" | "warn" | "bad"> = { OK: "good", PARTIAL: "warn", FAILED: "bad" };

const RunsPanel: React.FC<{ connector: Connector; canWrite: boolean; onChanged: () => void }> = ({ connector, canWrite, onChanged }) => {
  const [tick, setTick] = useState(0);
  const history = useApi<{ runs: RunRow[]; files: FileRow[] }>(`/integrations/${connector.id}/runs`, [connector.id, tick]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");

  const runTest = async () => {
    setTesting(true); setTest(null); setError("");
    try { setTest(await api(`/integrations/${connector.id}/test-pull`, { method: "POST", timeoutMs: 90_000 })); }
    catch (e: any) { setError(e.message); } finally { setTesting(false); }
  };
  const runNow = async (mode?: "backfill") => {
    setBusy(true); setResult(null); setError("");
    try {
      const r = await api<{ status: string; message: string }>(`/integrations/${connector.id}/run`, { method: "POST", body: mode ? { mode } : {}, timeoutMs: 10 * 60_000 });
      setResult({ ok: r.status !== "FAILED", text: r.message }); setTick((t) => t + 1); onChanged();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const { session } = useForecast();
  const saved: ScheduleDraft = { scheduleMin: connector.scheduleMin, scheduleAt: connector.scheduleAt, scheduleDays: connector.scheduleDays };
  const [draft, setDraft] = useState<ScheduleDraft>(saved);
  useEffect(() => setDraft(saved), [connector.id, connector.scheduleMin, connector.scheduleAt, JSON.stringify(connector.scheduleDays)]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const saveSchedule = async () => {
    setError("");
    try { await api(`/integrations/${connector.id}`, { method: "PUT", body: draft }); onChanged(); }
    catch (e: any) { setError(e.message); }
  };
  const [test, setTest] = useState<{ columns: string[]; rowCount: number; sample: Record<string, unknown>[]; problems: string[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const isDb = connector.preset === "DATABASE_POSTGRES_PULL";
  const attention = history.data?.files.filter((f) => f.status === "NEEDS_ATTENTION") ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-[13px] font-semibold">Schedule and runs</div>
        {connector.canPull && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {(isDb || connector.method === "API_PULL") && <Btn disabled={!canWrite || testing} onClick={runTest}>{testing ? "Testing…" : isDb ? "Test the query" : "Test connection"}</Btn>}
            {isDb && <Btn disabled={!canWrite || busy || connector.status !== "ACTIVE"} onClick={() => runNow("backfill")}>Load history</Btn>}
            <Btn variant="primary" disabled={!canWrite || busy || connector.status !== "ACTIVE"} onClick={() => runNow()}>{busy ? "Running…" : isDb ? "Run now (last 2 days)" : "Run now"}</Btn>
          </div>
        )}
      </div>
      {connector.canPull && (
        <div className="space-y-2 p-3 border border-[#E5E5E0] rounded bg-[#FAFAF8]">
          <div className="text-[12px] font-semibold">When we fetch it</div>
          <ScheduleEditor value={draft} onChange={setDraft} disabled={!canWrite} timezone={session.tenant.timezone} />
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Btn variant="primary" disabled={!canWrite || !dirty} onClick={saveSchedule}>Save schedule</Btn>
            <span className="text-[#6B6B6B]">{dirty ? "Not saved yet." : describeSchedule(saved, session.tenant.timezone)}</span>
          </div>
        </div>
      )}
      <p className="text-[12px] text-[#6B6B6B]">
        {connector.note || "This source sends its data to us, so there is nothing to schedule. Each delivery appears below."}
        {connector.canPull && connector.status !== "ACTIVE" && " Set the connector to Active for the schedule to run, or to run it by hand."}
        {connector.canPull && connector.status === "ACTIVE" && connector.scheduleMin && connector.nextRunAt && ` Next run ${when(connector.nextRunAt)} (${session.tenant.timezone}).`}
      </p>
      {isDb && connector.backfillStatus === "NOT_STARTED" && connector.status === "ACTIVE" && <Banner kind="info">No history has been loaded yet. Use Load history first: it stages the last weeks for review on the Staged Ingestion page, and forecasts need at least 4 weeks to work from.</Banner>}
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      {test && (
        <div className="space-y-2">
          <div className="text-[12px] text-[#6B6B6B]">The query returned {test.rowCount} row{test.rowCount === 1 ? "" : "s"} for the last two days (at most 20 are read for a test). Nothing was saved.</div>
          {test.problems.map((p) => <Banner key={p} kind="warn">{p}</Banner>)}
          {test.sample.length > 0 && (
            <div className="overflow-x-auto border border-[#E5E5E0] rounded">
              <table className="w-full text-[12px]"><thead className="bg-[#FAFAF8] text-[#6B6B6B]"><tr>{test.columns.map((c) => <th key={c} className="p-1.5 text-left">{c}</th>)}</tr></thead>
                <tbody>{test.sample.map((r, i) => <tr key={i} className="border-t border-[#E5E5E0]">{test.columns.map((c) => <td key={c} className="p-1.5 font-mono">{String(r[c] ?? "")}</td>)}</tr>)}</tbody></table>
            </div>
          )}
        </div>
      )}
      {result && <Banner kind={result.ok ? "ok" : "err"} onClose={() => setResult(null)}>{result.text}</Banner>}
      {attention.length > 0 && (
        <Banner kind="warn">
          <div className="font-semibold">{attention.length} file{attention.length === 1 ? "" : "s"} could not be read and {attention.length === 1 ? "was" : "were"} left alone</div>
          {attention.slice(0, 5).map((f) => <div key={f.fileName + f.seenAt}>{f.fileName}: {f.message}</div>)}
          <div className="mt-1">Fix the file and put it back in the folder. A changed file is picked up again.</div>
        </Banner>
      )}
      {history.data && history.data.runs.length > 0 && (
        <Table head={["When", "How", "Result", "Rows saved / sent", "What happened"]} right={[3]}>
          {history.data.runs.slice(0, 10).map((r, i) => (
            <tr key={i}>
              <td className="p-3 whitespace-nowrap">{when(r.startedAt)}</td>
              <td className="p-3">{KIND_LABEL[r.kind] ?? r.kind}<div className="text-[11px] text-[#6B6B6B]">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</div></td>
              <td className="p-3"><Pill tone={RUN_TONE[r.status] ?? "neutral"}>{r.status === "OK" ? "OK" : r.status === "PARTIAL" ? "Partly" : "Failed"}</Pill></td>
              <td className="p-3 text-right font-mono">{r.rowsOk.toLocaleString()} / {r.rowsIn.toLocaleString()}</td>
              <td className="p-3 text-[12px]">{r.message}</td>
            </tr>
          ))}
        </Table>
      )}
      {history.data && history.data.runs.length === 0 && <p className="text-[12px] text-[#6B6B6B]">No runs yet.</p>}
    </div>
  );
};

export const ConnectorDetail: React.FC<{ feeds?: boolean; connector: Connector; catalog: IntegrationCatalog | null; canWrite: boolean; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void; run: (fn: () => Promise<void>) => Promise<void> }> = ({ feeds, connector, catalog, canWrite, onChanged, onDeleted, onError, run }) => {
  const [tick, setTick] = useState(0);
  const maps = useApi<IntegrationFieldMap[]>(`/integrations/${connector.id}/field-maps`, [connector.id, tick]);
  const [rows, setRows] = useState<IntegrationFieldMap[]>([]);
  useEffect(() => setRows(maps.data ?? []), [maps.data]);
  const [busy, setBusy] = useState(false);
  const preset = useMemo(() => catalog && Object.values(catalog).flat().find((p) => p.id === connector.preset), [catalog, connector.preset]);
  const targetFields = TARGET_FIELDS[preset?.writesTo ?? ''] ?? [];
  const sampleFields = useMemo(() => flattenSample(connector.lastSample), [connector.lastSample]);
  const [menu, setMenu] = useState(false);
  const hasRules = preset?.writesTo === "agent_state" || connector.category === "ACD" || connector.category === "CRM" || connector.category === "HRMS";
  const tabs: { id: DetailTab; label: string }[] = [
    { id: "overview", label: "Overview" }, ...(preset?.method === "STREAM_SUBSCRIBE" ? [{ id: "live" as const, label: "Live events" }] : []), ...(feeds ? [{ id: "runs" as const, label: "Schedule and runs" }] : []), { id: "mapping", label: "Field mapping" }, ...(hasRules ? [{ id: "rules" as const, label: preset?.writesTo === "agent_state" ? "Event types and agents" : "Matching" }] : []),
  ];
  const [tab, setTab] = useState<DetailTab>("overview");
  useEffect(() => setTab("overview"), [connector.id]);                 // a different connector opens on its overview
  const configRows = Object.entries(connector.config).filter(([k]) => k !== "natsServers").map(([k, v]) => configRow(k, v));

  const dropOnTarget = (targetField: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const path = e.dataTransfer.getData('text/plain');
    if (!path) return;
    setRows((s) => { const i = s.findIndex((r) => r.targetField === targetField); const next = { targetField, sourcePath: path, transform: null };
      return i >= 0 ? s.map((r, j) => (j === i ? next : r)) : [...s, next]; });
  };

  const saveMaps = () => run(async () => { setBusy(true); try { await api(`/integrations/${connector.id}/field-maps`, { method: "PUT", body: rows }); } finally { setBusy(false); } });
  const [testResult, setTestResult] = useState<MapTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const testMaps = async () => {
    setTestBusy(true); setTestError(""); setTestResult(null);
    try { setTestResult(await api<MapTestResult>(`/integrations/${connector.id}/field-maps/test`, { method: "POST", body: { maps: rows } })); }
    catch (e: any) { setTestError(e.message); } finally { setTestBusy(false); }
  };
  const setStatus = (status: string) => run(async () => { await api(`/integrations/${connector.id}`, { method: "PUT", body: { status } }); onChanged(); });
  const remove = () => { if (!confirm(`Delete "${connector.name}"?`)) return; run(async () => { await api(`/integrations/${connector.id}`, { method: "DELETE" }); onDeleted(); }); };

  return (
    <Card title={connector.name} sub={preset && preset.label !== connector.name ? preset.label : CATEGORIES.find((c) => c.id === connector.category)?.label ?? connector.category}
      actions={canWrite && <>
        <Select value={connector.status} onChange={(e) => setStatus(e.target.value)} className="!w-auto"><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></Select>
        <div className="relative">
          <Btn aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><MoreHorizontal className="w-4 h-4" /></Btn>
          {menu && (
            <div role="menu" className="absolute right-0 mt-1 w-44 rounded border border-[#E5E5E0] bg-white shadow-md z-10">
              <button role="menuitem" className="w-full text-left px-3 py-2 text-[12px] text-[#BC3F3F] hover:bg-[#FAFAF8] flex items-center gap-2" onClick={() => { setMenu(false); remove(); }}><Trash2 className="w-3.5 h-3.5" />Delete connector…</button>
            </div>
          )}
        </div>
      </>}>
      <div role="tablist" aria-label="Connector sections" className="flex flex-wrap gap-1 border-b border-[#E5E5E0] -mt-1">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-[13px] -mb-px border-b-2 ${tab === t.id ? "border-[#171717] font-semibold text-[#171717]" : "border-transparent text-[#6B6B6B] hover:text-[#171717]"}`}>{t.label}</button>
        ))}
      </div>
      {connector.lastError && <Banner kind="err">Last error: {connector.lastError}</Banner>}

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {preset?.method === "STREAM_SUBSCRIBE"
              ? <Tile label="Connection" value={connector.connectedAt ? "Connected" : "Not connected"} tone={connector.connectedAt ? "good" : "neutral"} note={connector.connectedAt ? `since ${when(connector.connectedAt)}` : "Set the connector to Active"} />
              : <Tile label="Backfill" value={connector.backfillStatus.replace("_", " ").toLowerCase()} note={connector.backfillThrough ? `through ${connector.backfillThrough}` : undefined} />}
            <Tile label="Last data received" value={connector.lastReceivedAt ? agoText(connector.lastReceivedAt) : "never"} note={connector.lastReceivedAt ? when(connector.lastReceivedAt) : undefined} />
            {typeof connector.rows24h === "number" && <Tile label="Rows in 24 hours" value={connector.rows24h.toLocaleString()} />}
            <Tile label="Created" value={when(connector.createdAt)} note={connector.createdBy ? `by ${connector.createdBy}` : undefined} />
          </div>
          {preset?.method === "STREAM_SUBSCRIBE" && <ConnectionTest connector={connector} canWrite={canWrite} />}
          {configRows.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[13px] font-semibold">Connection details</div>
              <dl className="border border-[#E5E5E0] rounded-lg divide-y divide-[#E5E5E0] text-[13px]">
                {configRows.map((r) => (
                  <div key={r.label} className="grid grid-cols-[200px_minmax(0,1fr)] gap-3 px-3 py-2">
                    <dt className="text-[#6B6B6B]">{r.label}</dt>
                    <dd className="min-w-0 break-words">
                      <span className="font-mono text-[12px]">{r.value}</span>
                      {r.warn && <div className="text-[12px] text-[#8F6200] mt-0.5">{r.warn}</div>}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-[11px] text-[#6B6B6B]">Passwords and keys are kept hidden.</p>
            </div>
          )}
        </div>
      )}

      {tab === "live" && <LiveEvents connector={connector} />}

      {tab === "runs" && feeds && <RunsPanel connector={connector} canWrite={canWrite} onChanged={onChanged} />}

      {tab === "mapping" && sampleFields.length > 0 && targetFields.length > 0 && (
        <div className="space-y-2">
          <div className="text-[13px] font-semibold">Map by drag and drop</div>
          <p className="text-[12px] text-[#6B6B6B]">From the last real message this connector received. Drag a field from the sample onto the target it belongs to.</p>
          <div className="flex flex-wrap gap-1.5 p-2.5 border border-dashed border-[#D6D6D0] rounded-lg bg-[#FAFAF8]">
            {sampleFields.map((f) => (
              <span key={f.path} draggable={canWrite} onDragStart={(e) => e.dataTransfer.setData('text/plain', f.path)}
                title={f.value} className={`text-[11px] font-mono px-2 py-1 rounded border border-[#E5E5E0] bg-white ${canWrite ? "cursor-grab active:cursor-grabbing" : ""}`}>
                {f.path} <span className="text-[#6B6B6B]">= {f.value.length > 20 ? `${f.value.slice(0, 20)}…` : f.value}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {targetFields.map((tf) => {
              const row = rows.find((r) => r.targetField === tf);
              return (
                <div key={tf} onDragOver={canWrite ? (e) => e.preventDefault() : undefined} onDrop={canWrite ? dropOnTarget(tf) : undefined}
                  className={`border-2 border-dashed rounded-lg p-2 text-[11px] ${row ? "border-[#2F7D5A] bg-[#EAF5EF]" : "border-[#E5E5E0] bg-white"}`}>
                  <div className="font-semibold">{FIELD_LABEL[tf] ?? tf}</div>
                  <div className="font-mono text-[#525252] truncate">{row ? row.sourcePath : "drop a field here"}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}


      {tab === "mapping" && <div className="space-y-2">
        <div className="text-[13px] font-semibold">Field mapping{sampleFields.length > 0 && targetFields.length > 0 ? ", by hand" : ""}</div>
        <p className="text-[12px] text-[#6B6B6B]">Where each of our fields comes from in this vendor's own payload. Pre-filled for a named preset; blank for Generic -- fill in your own response shape. The same rows the drag-and-drop above writes to -- use this for a transform (ms → seconds etc.) or a field outside the usual set.</p>
        {rows.map((r, i) => {
          const required = targetFields.includes(r.targetField);
          return (
            <div key={i} className="flex items-center gap-2">
              {required ? (
                <div className="w-50 shrink-0 px-2.5 py-2 text-[13px] font-semibold" title={`Backend field: ${r.targetField} -- the name is fixed so ingest can't silently break`}>
                  {FIELD_LABEL[r.targetField] ?? r.targetField}
                </div>
              ) : (
                <Input disabled={!canWrite} value={r.targetField} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, targetField: e.target.value } : x)))} placeholder="our field (volume, ahtSec, state...)" className="max-w-[200px]" />
              )}
              <span className="text-[11px] text-[#6B6B6B]">←</span>
              <Input disabled={!canWrite} value={r.sourcePath} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, sourcePath: e.target.value } : x)))} placeholder="their field (data.stats.offered)" className="max-w-[260px]" />
              <Select disabled={!canWrite} value={r.transform ?? ""} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, transform: e.target.value || null } : x)))} className="!w-auto"><option value="">no conversion</option><option value="ms_to_s">ms → seconds</option><option value="minutes_to_s">minutes → seconds</option></Select>
              {canWrite && (required ? (
                <button title="Clear what it's mapped from (the slot itself stays, since this field is required)" className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setRows((s) => s.map((x, j) => (j === i ? { ...x, sourcePath: "" } : x)))}><Trash2 className="w-4 h-4" /></button>
              ) : (
                <button className="text-[#6B6B6B] hover:text-[#BC3F3F]" onClick={() => setRows((s) => s.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
              ))}
            </div>
          );
        })}
        {canWrite && (
          <div className="flex items-center gap-2 flex-wrap">
            <Btn onClick={() => setRows((s) => [...s, { targetField: "", sourcePath: "", transform: null }])}><Plus className="w-3.5 h-3.5" />Add field</Btn>
            <Btn disabled={testBusy || !sampleFields.length} title={sampleFields.length ? undefined : "Needs a real sample to test against -- nothing received yet"} onClick={testMaps}>{testBusy ? "Testing…" : "Test mapping"}</Btn>
            <Btn variant="primary" disabled={busy} onClick={saveMaps}>Save field mapping</Btn>
          </div>
        )}
        {testError && <Banner kind="err" onClose={() => setTestError("")}>{testError}</Banner>}
        {testResult && (
          <div className={`border rounded-lg p-3 space-y-2 text-[12px] ${testResult.ok ? "border-[#2F7D5A]/30 bg-[#EAF5EF]" : "border-[#E9D9B4] bg-[#FFF5DD]"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="font-semibold">{testResult.ok ? "This mapping is ready -- nothing was saved or sent anywhere." : "This mapping has a problem -- nothing was saved or sent anywhere."}</div>
              <button aria-label="Close" className="text-[#6B6B6B] hover:text-[#171717] text-[14px] leading-none shrink-0" onClick={() => setTestResult(null)}>&times;</button>
            </div>
            {testResult.issues.map((msg, i) => <div key={i} className="text-[#8F6200]">{msg}</div>)}
            {testResult.notes.map((msg, i) => <div key={i} className="text-[#6B6B6B]">{msg}</div>)}
            <div className="font-mono text-[11px] bg-white/60 rounded p-2 space-y-0.5">
              {Object.entries(testResult.resolved).map(([k, v]) => <div key={k}>{k}: <span className="font-semibold">{v === null || v === undefined || v === "" ? "–" : String(v)}</span></div>)}
            </div>
          </div>
        )}
      </div>}

      {tab === "rules" && <>
        {preset?.writesTo === "agent_state" && <EventTypeRules connectorId={connector.id} canWrite={canWrite} />}
        {connector.category === "ACD" && preset?.writesTo !== "agent_state" && <EntityMatching connectorId={connector.id} entityType="queue" canWrite={canWrite} />}
        {(connector.category === "CRM" || connector.category === "HRMS" || preset?.writesTo === "agent_state") && <EntityMatching connectorId={connector.id} entityType="employee" canWrite={canWrite} />}
      </>}
    </Card>
  );
};

/** What a raw event type (e.g. EVT_AGENT_READY) means, for the messages that carry no state of their own --
 * logins, logouts, heartbeats. A new event type starts PENDING and every message of that type is dropped
 * until someone sets it here; this is the only place that can resolve a PENDING rule. */
const EventTypeRules: React.FC<{ connectorId: string; canWrite: boolean }> = ({ connectorId, canWrite }) => {
  const [tick, setTick] = useState(0);
  const rules = useApi<EventRule[]>(`/integrations/${connectorId}/event-rules`, [connectorId, tick]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "SKIP" | "STATE"; state: string; reason: string }>({ mode: "SKIP", state: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startEdit = (r: EventRule) => {
    setEditing(r.eventType);
    setForm({ mode: r.action === "STATE" ? "STATE" : "SKIP", state: r.state ?? "", reason: r.reason ?? "" });
    setError("");
  };
  const save = async (eventType: string) => {
    setBusy(true); setError("");
    try {
      await api(`/integrations/${connectorId}/event-rules/${encodeURIComponent(eventType)}`, {
        method: "PUT", body: { action: form.mode, state: form.mode === "STATE" ? form.state.trim() : null, reason: form.mode === "STATE" ? (form.reason.trim() || null) : null },
      });
      setEditing(null); setTick((t) => t + 1);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!rules.data?.length) return null;
  const pending = rules.data.filter((r) => r.action === "PENDING");

  return (
    <div className="space-y-2">
      <div className="text-[13px] font-semibold">Event types</div>
      <p className="text-[12px] text-[#6B6B6B]">
        What each raw event type means when the message itself carries no state of its own.
        {pending.length > 0 ? ` ${pending.length} event type${pending.length === 1 ? " is" : "s are"} waiting for a rule -- every message of that type is being dropped until it's set.` : " All event types seen so far have a rule."}
      </p>
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      <div className="space-y-1.5">
        {rules.data.map((r) => (
          <div key={r.eventType} className={`border rounded-lg p-2.5 text-[12px] ${r.action === "PENDING" ? "border-[#E9D9B4] bg-[#FFF5DD]" : "border-[#E5E5E0]"}`}>
            {editing === r.eventType ? (
              <div className="space-y-2">
                <div className="font-mono font-semibold">{r.eventType}</div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5"><input type="radio" checked={form.mode === "SKIP"} onChange={() => setForm((f) => ({ ...f, mode: "SKIP" }))} />Ignore this event type</label>
                  <label className="flex items-center gap-1.5"><input type="radio" checked={form.mode === "STATE"} onChange={() => setForm((f) => ({ ...f, mode: "STATE" }))} />It means a state change</label>
                </div>
                {form.mode === "STATE" && (
                  <div className="flex gap-2">
                    <Input value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))} placeholder="State, e.g. READY" className="max-w-40" />
                    <Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Reason (optional)" className="max-w-40" />
                  </div>
                )}
                <div className="flex gap-2">
                  <Btn variant="primary" disabled={busy || (form.mode === "STATE" && !form.state.trim())} onClick={() => save(r.eventType)}>Save</Btn>
                  <Btn onClick={() => setEditing(null)}>Cancel</Btn>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <span className="font-mono font-semibold">{r.eventType}</span>
                  <span className="text-[#6B6B6B]"> · seen {r.seenCount}x · last {when(r.lastSeenAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {r.action === "PENDING" ? <Pill tone="warn">Waiting for a rule</Pill>
                    : r.action === "SKIP" ? <Pill>Ignored</Pill>
                    : <Pill tone="good">{"→ "}{r.state}{r.reason ? ` / ${r.reason}` : ""}</Pill>}
                  {canWrite && <button className="text-[11px] underline" onClick={() => startEdit(r)}>{r.action === "PENDING" ? "Set rule" : "Edit"}</button>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const EntityMatching: React.FC<{ connectorId: string; entityType: "queue" | "employee" | "skill"; canWrite: boolean }> = ({ connectorId, entityType, canWrite }) => {
  const [pasted, setPasted] = useState("");
  const [suggestions, setSuggestions] = useState<EntitySuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const existing = useApi<{ entityType: string; sourceId: string; sourceLabel: string; targetId: string | null }[]>(`/integrations/${connectorId}/entity-matches?entityType=${entityType}`, [connectorId, tick]);

  const suggest = async () => {
    setBusy(true); setError("");
    try {
      const seen = pasted.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [sourceId, ...rest] = l.split(","); return { sourceId: sourceId.trim(), sourceLabel: (rest.join(",") || sourceId).trim() }; });
      if (!seen.length) return setError("Paste at least one line as: id, label");
      setSuggestions(await api(`/integrations/${connectorId}/entity-matches/suggest`, { method: "POST", body: { entityType, seen } }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!suggestions) return; setBusy(true); setError("");
    try { await api(`/integrations/${connectorId}/entity-matches`, { method: "PUT", body: { entityType, matches: suggestions.map((s) => ({ sourceId: s.sourceId, sourceLabel: s.sourceLabel, targetId: s.targetId })) } }); setSuggestions(null); setPasted(""); setTick((t) => t + 1); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="text-[13px] font-semibold">{entityType === "queue" ? "Queue" : "Employee"} matching</div>
      <p className="text-[12px] text-[#6B6B6B]">The part that can't be guessed: this vendor's own identifiers, matched to ours. {existing.data?.length ? `${existing.data.length} already matched.` : "None matched yet."}</p>
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      {existing.data && existing.data.length > 0 && (
        <div className="text-[12px] space-y-1 max-h-32 overflow-y-auto border border-[#E5E5E0] rounded p-2">
          {existing.data.map((m) => <div key={m.sourceId} className="flex justify-between"><span>{m.sourceLabel} ({m.sourceId})</span><span>{m.targetId ? "matched" : "unmatched"}</span></div>)}
        </div>
      )}
      {canWrite && (
        <>
          <textarea className="w-full p-2 border border-[#E5E5E0] rounded text-[12px] font-mono h-20" placeholder={`one per line: their id, their label\n8892, Support Voice`} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <Btn disabled={busy} onClick={suggest}>Suggest matches</Btn>
          {suggestions && (
            <div className="space-y-1">
              {suggestions.map((s) => <div key={s.sourceId} className="text-[12px] flex justify-between"><span>{s.sourceLabel}</span><span className={s.targetId ? "text-[#2A7553]" : "text-[#BC3F3F]"}>{s.targetName ?? "no match"} {s.targetId ? `(${Math.round(s.score * 100)}%)` : ""}</span></div>)}
              <Btn variant="primary" disabled={busy} onClick={confirm}>Save these matches</Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
};
