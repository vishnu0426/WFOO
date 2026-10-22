/**
 * Configuration › Integration Station. Category, then provider, then that provider's real credential fields, all on
 * one page -- the pattern Segment's Sources Catalog and the embedded-iPaaS platforms (Workato, Paragon) use. Every
 * named provider is a preset of one of six generic delivery methods; "Generic" in any category is the answer to a
 * custom or proprietary system -- either its own REST API (configure the mapping, no code from us) or a closed
 * system (we issue an API key; the customer's own team's connector posts to our documented ingest endpoint).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, Connector, ConnectorCreated, EntitySuggestion, IntegrationCatalog, IntegrationField, IntegrationFieldMap, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "../forecasting/hooks";
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from "../forecasting/ui";

const CATEGORIES = [
  { id: "ACD", label: "ACD (voice/chat volume, agent state)" }, { id: "CRM", label: "CRM (agent presence)" },
  { id: "HRMS", label: "HRMS (employee sync)" }, { id: "DATABASE", label: "Database (direct read)" },
  { id: "ONPREM", label: "On-prem ACD (custom/closed)" }, { id: "SFTP", label: "File / SFTP" },
] as const;

const statusTone = (s: string) => (s === "ACTIVE" ? "good" : s === "ERROR" ? "bad" : s === "PAUSED" ? "warn" : "neutral") as "good" | "bad" | "warn" | "neutral";
const freshness = (lastReceivedAt: string | null) => {
  if (!lastReceivedAt) return { label: "Never received data", tone: "neutral" as const };
  const mins = (Date.now() - new Date(lastReceivedAt).getTime()) / 60000;
  if (mins < 60) return { label: `Fresh, ${Math.round(mins)} min ago`, tone: "good" as const };
  if (mins < 24 * 60) return { label: `${Math.round(mins / 60)}h ago`, tone: "warn" as const };
  return { label: `Stale, ${Math.round(mins / 1440)}d ago`, tone: "bad" as const };
};

export const IntegrationStationPanel: React.FC = () => {
  const { groups, can } = useForecast();
  const canWrite = can("config:write");
  const [tick, setTick] = useState(0);
  const catalog = useApi<IntegrationCatalog>("/integrations/catalog");
  const connectors = useApi<Connector[]>("/integrations", [tick]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [justCreated, setJustCreated] = useState<ConnectorCreated | null>(null);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => { setError(""); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } };

  return (
    <div className="space-y-6">
      {error && <Banner kind="err" onClose={() => setError("")}>{error}</Banner>}
      {justCreated && (
        <Banner kind="ok" onClose={() => setJustCreated(null)}>
          <div className="space-y-1">
            <div className="font-semibold">"{justCreated.name}" created. {justCreated.apiKey ? "Save this API key now -- it will not be shown again." : "Save this webhook secret now -- it will not be shown again."}</div>
            {justCreated.apiKey && <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">{justCreated.apiKey}</div>}
            {justCreated.webhookSecret && <>
              <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">Secret: {justCreated.webhookSecret}</div>
              <div className="font-mono text-[12px] bg-white/60 rounded px-2 py-1 select-all">URL: {location.origin.replace(/:\d+$/, ":4000")}{justCreated.webhookUrl}</div>
            </>}
          </div>
        </Banner>
      )}

      <Card title="Connectors" sub="Real, vendor-specific integrations -- ACD, CRM, HRMS, a database, an on-prem system or a scheduled file. Historical data lands in Staged Ingestion for review, exactly like a manual CSV upload; live data feeds interval history or RTA state directly."
        actions={canWrite && <Btn variant="primary" onClick={() => { setCreating((c) => !c); setSelected(""); }}><Plus className="w-3.5 h-3.5" />{creating ? "Cancel" : "New connector"}</Btn>}>
        {creating && catalog.data && <NewConnectorForm catalog={catalog.data} groups={groups} onCreated={(c) => { setCreating(false); setJustCreated(c); setSelected(c.id); setTick((t) => t + 1); }} onError={setError} />}

        {connectors.loading && !connectors.data ? <Busy text="Loading connectors…" /> : !connectors.data?.length ? (
          <Empty title="No connectors yet">Add one for the ACD, CRM or HRMS system you actually use, or a direct database read.</Empty>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {connectors.data.map((c) => {
              const f = freshness(c.lastReceivedAt);
              return (
                <button key={c.id} onClick={() => setSelected(selected === c.id ? "" : c.id)} className={`text-left p-3 rounded-lg border ${selected === c.id ? "border-[#171717] bg-[#FAFAF8]" : "border-[#E5E5E0] hover:bg-[#FAFAF8]"}`}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-[13px]">{c.name}</span>
                    <div className="flex gap-1.5"><Pill tone={statusTone(c.status)}>{c.status}</Pill><Pill tone={f.tone}>{f.label}</Pill></div>
                  </div>
                  <div className="text-[11px] text-[#737373] mt-1">{c.category} · {c.preset} · {c.method.replace(/_/g, " ").toLowerCase()}</div>
                  {c.lastError && <div className="text-[11px] text-[#C84A4A] mt-1">{c.lastError}</div>}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {selected && connectors.data?.find((c) => c.id === selected) && (
        <ConnectorDetail connector={connectors.data.find((c) => c.id === selected)!} catalog={catalog.data ?? null} canWrite={canWrite} onChanged={() => setTick((t) => t + 1)} onDeleted={() => { setSelected(""); setTick((t) => t + 1); }} onError={setError} run={run} />
      )}
    </div>
  );
};

// ---------------------------------------------------------------- create

const FieldInput: React.FC<{ f: IntegrationField; value: string; onChange: (v: string) => void }> = ({ f, value, onChange }) => {
  if (f.kind === "select") return <Select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>;
  if (f.kind === "file") return <textarea className="w-full p-2 border border-[#E5E5E0] rounded text-[12px] font-mono h-20" placeholder="Paste the file's contents" value={value} onChange={(e) => onChange(e.target.value)} />;
  return <Input type={f.kind === "password" ? "password" : "text"} value={value} onChange={(e) => onChange(e.target.value)} />;
};

const NewConnectorForm: React.FC<{ catalog: IntegrationCatalog; groups: { id: string; name: string }[]; onCreated: (c: ConnectorCreated) => void; onError: (m: string) => void }> = ({ catalog, groups, onCreated, onError }) => {
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

  const create = async () => {
    setBusy(true);
    try {
      const c = await api<ConnectorCreated>("/integrations", { method: "POST", body: { category, preset: presetId, name: name || `${preset?.label} connector`, wfmGroupId: groupId || null, config } });
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
      {preset?.note && <p className="text-[12px] text-[#525252] bg-[#FAFAF8] border border-[#E5E5E0] rounded p-2">{preset.note}</p>}
      {preset && preset.fields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {preset.fields.map((f) => (
            <Field key={f.key} label={f.label + (f.required ? " *" : "")} hint={f.help}>
              <FieldInput f={f} value={config[f.key] ?? ""} onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))} />
            </Field>
          ))}
        </div>
      )}
      {preset && preset.fields.length === 0 && <p className="text-[12px] text-[#737373]">No credentials to enter -- we issue an API key on creation and your own connector script uses it.</p>}
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

const ConnectorDetail: React.FC<{ connector: Connector; catalog: IntegrationCatalog | null; canWrite: boolean; onChanged: () => void; onDeleted: () => void; onError: (m: string) => void; run: (fn: () => Promise<void>) => Promise<void> }> = ({ connector, catalog, canWrite, onChanged, onDeleted, onError, run }) => {
  const [tick, setTick] = useState(0);
  const maps = useApi<IntegrationFieldMap[]>(`/integrations/${connector.id}/field-maps`, [connector.id, tick]);
  const [rows, setRows] = useState<IntegrationFieldMap[]>([]);
  useEffect(() => setRows(maps.data ?? []), [maps.data]);
  const [busy, setBusy] = useState(false);
  const preset = useMemo(() => catalog && Object.values(catalog).flat().find((p) => p.id === connector.preset), [catalog, connector.preset]);
  const targetFields = TARGET_FIELDS[preset?.writesTo ?? ''] ?? [];
  const sampleFields = useMemo(() => flattenSample(connector.lastSample), [connector.lastSample]);

  const dropOnTarget = (targetField: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const path = e.dataTransfer.getData('text/plain');
    if (!path) return;
    setRows((s) => { const i = s.findIndex((r) => r.targetField === targetField); const next = { targetField, sourcePath: path, transform: null };
      return i >= 0 ? s.map((r, j) => (j === i ? next : r)) : [...s, next]; });
  };

  const saveMaps = () => run(async () => { setBusy(true); try { await api(`/integrations/${connector.id}/field-maps`, { method: "PUT", body: rows }); } finally { setBusy(false); } });
  const setStatus = (status: string) => run(async () => { await api(`/integrations/${connector.id}`, { method: "PUT", body: { status } }); onChanged(); });
  const remove = () => { if (!confirm(`Delete "${connector.name}"?`)) return; run(async () => { await api(`/integrations/${connector.id}`, { method: "DELETE" }); onDeleted(); }); };

  return (
    <Card title={connector.name} sub={`${connector.category} · ${connector.preset}`}
      actions={canWrite && <>
        <Select value={connector.status} onChange={(e) => setStatus(e.target.value)} className="!w-auto"><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></Select>
        <Btn onClick={remove}><Trash2 className="w-3.5 h-3.5" />Delete</Btn>
      </>}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
        {preset?.method === "STREAM_SUBSCRIBE" && (
          <div>
            <div className="text-[#737373]">Connection</div>
            <div className={`font-semibold ${connector.connectedAt ? "text-[#2F7D5A]" : "text-[#737373]"}`}>{connector.connectedAt ? `Connected since ${when(connector.connectedAt)}` : "Not yet connected"}</div>
          </div>
        )}
        <div><div className="text-[#737373]">Backfill</div><div className="font-semibold">{connector.backfillStatus.replace("_", " ").toLowerCase()}{connector.backfillThrough ? ` through ${connector.backfillThrough}` : ""}</div></div>
        <div><div className="text-[#737373]">Last received</div><div className="font-semibold">{connector.lastReceivedAt ? when(connector.lastReceivedAt) : "never"}</div></div>
        <div><div className="text-[#737373]">Created</div><div className="font-semibold">{when(connector.createdAt)} by {connector.createdBy}</div></div>
        <div><div className="text-[#737373]">Config</div><div className="font-semibold">{Object.entries(connector.config).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</div></div>
      </div>
      {connector.lastError && <Banner kind="err">Last error: {connector.lastError}</Banner>}

      {sampleFields.length > 0 && targetFields.length > 0 && (
        <div className="space-y-2">
          <div className="text-[13px] font-semibold">Map by drag and drop</div>
          <p className="text-[12px] text-[#737373]">From the last real message this connector received. Drag a field from the sample onto the target it belongs to.</p>
          <div className="flex flex-wrap gap-1.5 p-2.5 border border-dashed border-[#D6D6D0] rounded-lg bg-[#FAFAF8]">
            {sampleFields.map((f) => (
              <span key={f.path} draggable={canWrite} onDragStart={(e) => e.dataTransfer.setData('text/plain', f.path)}
                title={f.value} className={`text-[11px] font-mono px-2 py-1 rounded border border-[#E5E5E0] bg-white ${canWrite ? "cursor-grab active:cursor-grabbing" : ""}`}>
                {f.path} <span className="text-[#A3A3A3]">= {f.value.length > 20 ? `${f.value.slice(0, 20)}…` : f.value}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {targetFields.map((tf) => {
              const row = rows.find((r) => r.targetField === tf);
              return (
                <div key={tf} onDragOver={canWrite ? (e) => e.preventDefault() : undefined} onDrop={canWrite ? dropOnTarget(tf) : undefined}
                  className={`border-2 border-dashed rounded-lg p-2 text-[11px] ${row ? "border-[#2F7D5A] bg-[#EAF5EF]" : "border-[#E5E5E0] bg-white"}`}>
                  <div className="font-semibold">{tf}</div>
                  <div className="font-mono text-[#525252] truncate">{row ? row.sourcePath : "drop a field here"}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[13px] font-semibold">Field mapping{sampleFields.length > 0 && targetFields.length > 0 ? ", by hand" : ""}</div>
        <p className="text-[12px] text-[#737373]">Where each of our fields comes from in this vendor's own payload. Pre-filled for a named preset; blank for Generic -- fill in your own response shape. The same rows the drag-and-drop above writes to -- use this for a transform (ms → seconds etc.) or a field outside the usual set.</p>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input disabled={!canWrite} value={r.targetField} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, targetField: e.target.value } : x)))} placeholder="our field (volume, ahtSec, state...)" className="max-w-[200px]" />
            <span className="text-[11px] text-[#737373]">←</span>
            <Input disabled={!canWrite} value={r.sourcePath} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, sourcePath: e.target.value } : x)))} placeholder="their field (data.stats.offered)" className="max-w-[260px]" />
            <Select disabled={!canWrite} value={r.transform ?? ""} onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, transform: e.target.value || null } : x)))} className="!w-auto"><option value="">no conversion</option><option value="ms_to_s">ms → seconds</option><option value="minutes_to_s">minutes → seconds</option></Select>
            {canWrite && <button className="text-[#737373] hover:text-[#C84A4A]" onClick={() => setRows((s) => s.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>}
          </div>
        ))}
        {canWrite && <div className="flex gap-2"><Btn onClick={() => setRows((s) => [...s, { targetField: "", sourcePath: "", transform: null }])}><Plus className="w-3.5 h-3.5" />Add field</Btn><Btn variant="primary" disabled={busy} onClick={saveMaps}>Save field mapping</Btn></div>}
      </div>

      {connector.category === "ACD" && preset?.writesTo !== "agent_state" && <EntityMatching connectorId={connector.id} entityType="queue" canWrite={canWrite} />}
      {(connector.category === "CRM" || connector.category === "HRMS" || preset?.writesTo === "agent_state") && <EntityMatching connectorId={connector.id} entityType="employee" canWrite={canWrite} />}
    </Card>
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
      <p className="text-[12px] text-[#737373]">The part that can't be guessed: this vendor's own identifiers, matched to ours. {existing.data?.length ? `${existing.data.length} already matched.` : "None matched yet."}</p>
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
              {suggestions.map((s) => <div key={s.sourceId} className="text-[12px] flex justify-between"><span>{s.sourceLabel}</span><span className={s.targetId ? "text-[#2F7D5A]" : "text-[#C84A4A]"}>{s.targetName ?? "no match"} {s.targetId ? `(${Math.round(s.score * 100)}%)` : ""}</span></div>)}
              <Btn variant="primary" disabled={busy} onClick={confirm}>Save these matches</Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
};
