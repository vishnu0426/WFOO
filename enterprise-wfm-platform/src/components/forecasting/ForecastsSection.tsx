/**
 * Forecasts: one row per forecast (a WFM group's short-term or long-term forecast) with its numbered versions underneath, the live one pinned to the top. History is never overwritten:
 * each change is a new version. Click a forecast or a version to open it on the dashboard; each row has a menu (open, compare, move it along, clone, export, archive, delete).
 */
import { Waiting } from '../common/loading';
import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Search, SlidersHorizontal } from "lucide-react";
import { api, CHANNEL_LABEL, download, isNew, MODEL_LABEL, STATUS_LABEL, type VersionMeta, type VersionStatus, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { COLUMNS_KEY, OPTIONAL_COLUMNS, defaultBase, groupFamilies, horizonLabel, originOf, readColumns, rowActions, shortWhen, type Family, type OptionalColumn, type RowAction } from "../../services/forecastLineage";
import { OTHER_MEASURES } from "../../services/accuracyTerms";
import { publishLines } from "../../services/liveForecasts";
import { useApi } from "./hooks";
import { Empty } from "./ui";
import { Confirm } from "../configuration/groups/shared";
import { RowMenu } from "../workforce/TeamsExtras";
import { CompareDrawer } from "./CompareVersions";
import { RefreshPanel } from "./RefreshPanel";
import { PageHeader, PrimaryButton, Select, StatusPill, Toolbar } from "../wfm/app-shell";

const wapeTone = (w: number | null) => (w === null ? "text-subtle-foreground" : w < 7 ? "text-success" : w < 9 ? "text-warning" : "text-critical");
const modelName = (m?: string | null) => (m ? (m === "mixed" ? "Mixed by queue" : MODEL_LABEL[m] ?? m) : "–");
const customName = (n: string) => !/^(Short|Long)-term v\d+/.test(n);
const isAuto = (n: string) => / · auto refresh$/.test(n);

type Pending = { kind: "publish" | "archive" | "return" | "delete"; v: VersionMeta };

export function ForecastsSection() {
  const { groups, group, setGroupId, setVersionId, go, can, reload, setNotice } = useForecast();
  const all = useApi<VersionMeta[]>("/forecast/versions");
  const [status, setStatus] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [cols, setCols] = useState(() => readColumns(localStorage.getItem(COLUMNS_KEY)));
  const [showCols, setShowCols] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cmp, setCmp] = useState<{ v: VersionMeta; members: VersionMeta[]; base: string } | null>(null);
  const [refreshFor, setRefreshFor] = useState<{ groupId: string; kind: "SHORT" | "LONG" } | null>(null);
  const sched = useApi<{ schedules: { groupId: string; kind: string; enabled: boolean; description: string }[] }>("/forecast/refresh");
  const schedOf = (g: string, k: string) => sched.data?.schedules.find((s) => s.groupId === g && s.kind === k && s.enabled) ?? null;
  const gname = (id: string) => groups.find((g) => g.id === id)?.name ?? "–";
  const channels = (id: string) => [...new Set(groups.find((g) => g.id === id)?.queues.map((q) => CHANNEL_LABEL[q.channel] ?? q.channel) ?? [])].join(", ") || "–";
  const byId = useMemo(() => new Map((all.data ?? []).map((v) => [v.id, v])), [all.data]);

  const families = useMemo(() => groupFamilies(all.data ?? [], { status: status as VersionStatus | "", groupId: groupFilter, query, groupName: gname }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all.data, status, groupFilter, query, groups]);
  const filtering = !!(status || groupFilter || query.trim());
  const isOpen = (f: Family) => filtering || open.has(f.key);                 // with a filter on, the versions that matched are shown
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const setCol = (c: OptionalColumn, on: boolean) => setCols((cur) => { const n = { ...cur, [c]: on }; localStorage.setItem(COLUMNS_KEY, JSON.stringify(n)); return n; });
  const live = families.filter((f) => f.live), rest = families.filter((f) => !f.live);
  const versionCount = families.reduce((n, f) => n + f.versions.length, 0);
  const extra = OPTIONAL_COLUMNS.filter((c) => cols[c.id]);

  const openVersion = (v: VersionMeta) => {
    if (group?.id === v.wfmGroupId) setVersionId(v.id); else setGroupId(v.wfmGroupId, v.id);
    go("forecast-dashboard");
  };
  const refresh = async () => { all.reload(); await reload().catch(() => undefined); };
  const post = async (v: VersionMeta, path: string, body: object, done: string) => {
    setBusy(true); setError("");
    try { await api(`/forecast/versions/${v.id}/${path}`, { method: "POST", body }); setPending(null); setNotice({ kind: "ok", text: done }); await refresh(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const run = async (v: VersionMeta, members: VersionMeta[], a: RowAction) => {
    try {
      if (a === "open") openVersion(v);
      else if (a === "compare") { const b = defaultBase(v, members); if (b) setCmp({ v, members, base: b.id }); }
      else if (a === "submit") await post(v, "submit", {}, `Submitted v${v.seq} for approval. It is now locked: approve it, or return it to draft.`);
      else if (a === "approve") await post(v, "approve", {}, `Approved v${v.seq}. Publish it to drive the schedule.`);
      else if (a === "clone") { setBusy(true); const c = await api<VersionMeta>(`/forecast/versions/${v.id}/clone`, { method: "POST" }); setNotice({ kind: "ok", text: `Created ${c.name}. Adjust it, then submit it for approval.` }); await refresh(); setOpen((o) => new Set(o).add(`${v.wfmGroupId}|${v.kind}`)); setBusy(false); }
      else if (a === "export") await download(`/forecast/versions/${v.id}/export.csv`, `forecast-v${v.seq}.csv`);
      else { setError(""); setPending({ kind: a === "publish" ? "publish" : a === "return" ? "return" : a === "archive" ? "archive" : "delete", v }); }
    } catch (e: any) { setBusy(false); setNotice({ kind: "err", text: e.message }); }
  };
  const confirm = async (reason: string) => {
    if (!pending) return; const { kind, v } = pending;
    if (kind === "publish") await post(v, "publish", {}, `Published v${v.seq}. Staffing coverage and the auto-scheduler now use it for ${horizonLabel(v.fromDay, v.toDay)}.${v.kind === "SHORT" && publishLines(v, all.data ?? []).replaces.length ? " The live version for the same period is archived." : ""}`);
    else if (kind === "return") await post(v, "reject", { reason }, `Returned v${v.seq} to draft.`);
    else if (kind === "archive") await post(v, "archive", { reason }, `Archived v${v.seq}. Clone it to work on it again.`);
    else {
      setBusy(true); setError("");
      try { await api(`/forecast/versions/${v.id}`, { method: "DELETE" }); setPending(null); setNotice({ kind: "ok", text: `Deleted v${v.seq}.` }); await refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    }
  };

  const LABEL: Record<RowAction, (v: VersionMeta) => string> = {
    open: () => "Open", compare: () => "Compare…", submit: () => "Submit for approval", approve: () => "Approve", publish: () => "Publish…", return: () => "Return to draft…",
    clone: () => "Clone to edit", export: () => "Export CSV", archive: () => "Archive…", delete: () => "Delete…",
  };
  const menu = (v: VersionMeta, members: VersionMeta[], who: string, family = false) => (
    <RowMenu label={`Actions for ${who}`} items={[...rowActions(v.status, can, { comparable: members.length > 1 }).map((a) => ({ label: LABEL[a](v), onClick: () => void run(v, members, a), danger: a === "delete" })), ...(family ? [{ label: "Auto-refresh…", onClick: () => setRefreshFor({ groupId: v.wfmGroupId, kind: v.kind as "SHORT" | "LONG" }), danger: false }] : [])]} />
  );

  const cell = "px-3 py-2.5 align-middle whitespace-nowrap overflow-hidden text-ellipsis";
  const cellMenu = "px-3 py-2.5 align-middle text-right";          // no overflow clipping: the menu opens out of this cell
  const head = (
    <tr>
      <th className="w-10 px-3 py-2" aria-label="Expand" />
      <th className="px-3 py-2 font-medium">Forecast</th>
      <th className="w-[110px] px-3 py-2 font-medium">Status</th>
      <th className="w-[205px] px-3 py-2 font-medium">Horizon</th>
      <th className="w-[150px] px-3 py-2 font-medium">Model</th>
      <th className="w-[80px] px-3 py-2 font-medium" title={OTHER_MEASURES.backtest.tip}>Test miss</th>
      <th className="w-[130px] px-3 py-2 font-medium">Versions</th>
      {cols.channel && <th className="w-[110px] px-3 py-2 font-medium">Channel</th>}
      {cols.interval && <th className="w-[80px] px-3 py-2 font-medium">Interval</th>}
      {cols.owner && <th className="w-[120px] px-3 py-2 font-medium">Owner</th>}
      <th className="w-[100px] px-3 py-2 font-medium">Updated</th>
      <th className="w-12 px-3 py-2"><span className="sr-only">Actions</span></th>
    </tr>
  );
  const colCount = 9 + extra.length;                                         // chevron, forecast, status, horizon, model, WAPE, versions, updated, menu, plus the optional ones

  const familyRows = (f: Family<VersionMeta>) => {
    const h = f.headline, wape = h.wape == null ? null : h.wape * 100, expanded = isOpen(f);
    const title = `${gname(f.groupId)} · ${f.kind === "SHORT" ? "Short-term" : "Long-term"}`;
    return (
      <React.Fragment key={f.key}>
        <tr className="border-b bg-background transition-colors hover:bg-surface" data-family={f.key}>
          <td className={cell}>
            <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} onClick={() => toggle(f.key)} className="rounded p-1 hover:bg-surface">
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          </td>
          <td className={cell} title={title}>
            <button className="font-medium hover:underline" onClick={() => openVersion(h)}>{title}</button>
            <div className="text-[12px] text-subtle-foreground">{f.live ? `Live: ${f.liveAll.map((x) => `v${x.seq}`).join(", ")}${f.liveAll.length > 1 ? ` (${f.liveAll.length} periods)` : ""}` : "Nothing live"}{schedOf(f.groupId, f.kind) && <button type="button" data-testid="refresh-chip" onClick={() => setRefreshFor({ groupId: f.groupId, kind: f.kind as "SHORT" | "LONG" })} className="ml-2 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-surface" title="Open the auto-refresh schedule">Auto-refresh {schedOf(f.groupId, f.kind)!.description.replace(/^every /, "")}</button>}{isNew(h) && <>{" "}<span className="ml-1 rounded-full bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">NEW</span></>}</div>
          </td>
          <td className={cell}><StatusPill status={h.status} /></td>
          <td className={cell} title={`${h.fromDay} to ${h.toDay}`}>{horizonLabel(h.fromDay, h.toDay)}</td>
          <td className={cell} title={modelName(h.model)}>{modelName(h.model)}</td>
          <td className={`${cell} font-medium ${wapeTone(wape)}`}>{wape === null ? "–" : `${wape.toFixed(1)}%`}</td>
          <td className={cell} title={`${f.total} version${f.total === 1 ? "" : "s"}${f.inProgress ? `, ${f.inProgress} not yet live or archived` : ""}`}>{f.total} version{f.total === 1 ? "" : "s"}{f.inProgress > 0 && <span className="ml-1 text-warning">· {f.inProgress} open</span>}</td>
          {cols.channel && <td className={cell} title={channels(f.groupId)}>{channels(f.groupId)}</td>}
          {cols.interval && <td className={cell}>{f.kind === "SHORT" ? "15 min" : "Daily"}</td>}
          {cols.owner && <td className={cell} title={h.createdBy ?? ""}>{h.createdBy ?? "–"}</td>}
          <td className={`${cell} text-subtle-foreground`} title={when(f.updatedAt)}>{shortWhen(f.updatedAt)}</td>
          <td className={cellMenu}>{menu(h, f.members, title, true)}</td>
        </tr>
        {expanded && f.versions.map((v) => {
          const w = v.wape == null ? null : v.wape * 100, from = originOf(v, byId), who = `${title} v${v.seq}`;
          return (
            <tr key={v.id} className={`border-b bg-surface/40 transition-colors hover:bg-surface ${v.status === "ARCHIVED" ? "text-muted-foreground" : ""}`} data-version={v.id} data-of={f.key}>
              <td className={cell} />
              <td className={`${cell} pl-8`} title={v.name}>
                <button className="font-medium hover:underline" onClick={() => openVersion(v)}>v{v.seq}</button>
                {from && <>{" "}<span className="ml-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground">{from}</span></>}
                {isNew(v) && <>{" "}<span className="ml-1 rounded-full bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">NEW</span></>}
                {isAuto(v.name) && <>{" "}<span className="ml-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Made by the scheduled auto-refresh">auto refresh</span></>}
                {customName(v.name) &&<>{" "}<span className="ml-1 text-[12px] text-subtle-foreground">{v.name}</span></>}
              </td>
              <td className={cell}><StatusPill status={v.status} /></td>
              <td className={cell} title={`${v.fromDay} to ${v.toDay}`}>{horizonLabel(v.fromDay, v.toDay)}</td>
              <td className={cell} title={modelName(v.model)}>{modelName(v.model)}</td>
              <td className={`${cell} font-medium ${wapeTone(w)}`}>{w === null ? "–" : `${w.toFixed(1)}%`}</td>
              <td className={cell} />
              {cols.channel && <td className={cell} />}
              {cols.interval && <td className={cell} />}
              {cols.owner && <td className={cell} title={v.createdBy ?? ""}>{v.createdBy ?? "–"}</td>}
              <td className={`${cell} text-subtle-foreground`} title={when(v.publishedAt ?? v.approvedAt ?? v.submittedAt ?? v.createdAt)}>{shortWhen(v.publishedAt ?? v.approvedAt ?? v.submittedAt ?? v.createdAt)}</td>
              <td className={cellMenu}>{menu(v, f.members, who)}</td>
            </tr>
          );
        })}
      </React.Fragment>
    );
  };
  const section = (title: string, list: Family<VersionMeta>[]) => list.length > 0 && (
    <>
      {(live.length > 0 && rest.length > 0) && <tr className="border-b bg-surface"><th colSpan={colCount} scope="colgroup" className="px-3 py-1.5 text-left text-[12px] font-semibold uppercase tracking-wide text-subtle-foreground">{title} ({list.length})</th></tr>}
      {list.map(familyRows)}
    </>
  );

  return (
    <div>
      <PageHeader
        breadcrumb={["Forecasting", "Forecasts"]}
        title="Forecasts"
        description="One row per forecast, its versions underneath. History is never overwritten: each change creates a new version."
        actions={can("forecast:create") && (
          <PrimaryButton onClick={() => go("forecast-builder")}><Plus className="size-3.5" /> New forecast</PrimaryButton>
        )}
      />
      <Toolbar>
        <label className="flex h-9 items-center gap-1.5 rounded-lg border bg-background px-3">
          <Search className="size-3.5 text-subtle-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search forecasts" aria-label="Search forecasts" className="w-56 bg-transparent text-[13px] outline-none" />
        </label>
        <Select label="Status" value={status} onChange={setStatus} options={[{ id: "", label: "All statuses" }, ...(Object.keys(STATUS_LABEL) as VersionStatus[]).map((s) => ({ id: s, label: STATUS_LABEL[s] }))]} />
        <Select label="Group" value={groupFilter} onChange={setGroupFilter} options={[{ id: "", label: "All groups" }, ...groups.map((g) => ({ id: g.id, label: g.name }))]} />
        <div className="relative">
          <button type="button" aria-haspopup="true" aria-expanded={showCols} onClick={() => setShowCols((s) => !s)} className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3 hover:bg-surface"><SlidersHorizontal className="size-3.5 text-subtle-foreground" />Columns{extra.length > 0 && <span className="rounded-full bg-foreground px-1.5 text-[11px] text-background">+{extra.length}</span>}</button>
          {showCols && (
            <div role="group" aria-label="Optional columns" className="absolute left-0 z-40 mt-1.5 w-52 space-y-2 rounded-lg border bg-background p-3 shadow-lg">
              <p className="text-[12px] text-subtle-foreground">Shown in addition to the usual columns</p>
              {OPTIONAL_COLUMNS.map((c) => <label key={c.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={cols[c.id]} onChange={(e) => setCol(c.id, e.target.checked)} />{c.label}</label>)}
              <button type="button" className="text-[12px] underline text-muted-foreground" onClick={() => setShowCols(false)}>Done</button>
            </div>)}
        </div>
        <button type="button" onClick={() => setOpen(open.size ? new Set() : new Set(families.map((f) => f.key)))} disabled={filtering} className="h-9 rounded-lg border bg-background px-3 hover:bg-surface disabled:opacity-50">{open.size ? "Collapse all" : "Expand all"}</button>
        <span className="num ml-auto text-subtle-foreground" role="status">{families.length} forecast{families.length === 1 ? "" : "s"} · {versionCount} version{versionCount === 1 ? "" : "s"}</span>
      </Toolbar>

      {all.error && <p className="px-6 py-3 text-[13px] text-critical">{all.error}</p>}
      {all.data === null && !all.error ? <div className="px-6 py-4"><Waiting what="forecasts" shape="table" reload={all.reload} /></div> : (all.data?.length ?? 0) === 0 && !all.loading ? (
        <div className="p-6"><Empty title="No forecasts yet">Create the first one in Forecast Builder once interval history is imported.</Empty></div>
      ) : families.length === 0 ? (
        <div className="p-6"><Empty title="No forecast matches">Change the search or the filters.</Empty></div>
      ) : (
        <div className={extra.length ? "overflow-x-auto" : ""}>
          <table className="num w-full table-fixed text-[13px]" style={{ minWidth: 860 + extra.length * 110 }}>
            <thead className="border-b bg-surface text-left text-[12px] text-subtle-foreground">{head}</thead>
            <tbody>
              {section("Live", live)}
              {section(live.length ? "Not live yet" : "Forecasts", rest)}
            </tbody>
          </table>
        </div>
      )}

      {refreshFor && (
        <RefreshPanel groupId={refreshFor.groupId} groupName={gname(refreshFor.groupId)} kind={refreshFor.kind} canEdit={can("forecast:create")} onClose={() => setRefreshFor(null)} onChanged={() => { sched.reload(); all.reload(); }}
          onOpenDraft={(id) => { const v = byId.get(id) ?? (all.data ?? []).find((x) => x.id === id); setRefreshFor(null); if (v) openVersion(v); }}
          onCompare={(id) => { const v = (all.data ?? []).find((x) => x.id === id); if (!v) return; const members = (all.data ?? []).filter((m) => m.wfmGroupId === v.wfmGroupId && m.kind === v.kind); const b = defaultBase(v, members); if (b) { setRefreshFor(null); setCmp({ v, members, base: b.id }); } }} />)}
      {cmp && <CompareDrawer version={cmp.v} members={cmp.members} baseId={cmp.base} onBase={(id) => setCmp({ ...cmp, base: id })} onClose={() => setCmp(null)} />}
      {pending?.kind === "publish" && (
        <Confirm title={`Publish v${pending.v.seq}?`} confirmLabel="Publish" busy={busy} error={error} onCancel={() => setPending(null)} onConfirm={() => void confirm("")}>
          <p>Staffing coverage and the auto-scheduler will use v{pending.v.seq} for {horizonLabel(pending.v.fromDay, pending.v.toDay)}.</p>
          {pending.v.kind === "SHORT"
            ? <ul className="mt-2 list-disc space-y-1 pl-5">{publishLines(pending.v, all.data ?? []).lines.map((l) => <li key={l}>{l}</li>)}</ul>
            : <p className="mt-2">The long-term forecast that is live now is archived.</p>}
        </Confirm>)}
      {pending?.kind === "return" && (
        <Confirm title={`Return v${pending.v.seq} to draft?`} confirmLabel="Return to draft" reason busy={busy} error={error} onCancel={() => setPending(null)} onConfirm={(r) => void confirm(r)}>
          <p>It can be changed again, then submitted. Say why it is being returned.</p>
        </Confirm>)}
      {pending?.kind === "archive" && (
        <Confirm title={`Archive v${pending.v.seq}?`} confirmLabel="Archive" reason busy={busy} error={error} onCancel={() => setPending(null)} onConfirm={(r) => void confirm(r)}>
          <p>It leaves the working list but is kept. Clone it to work on it again. The live version cannot be archived: publish another one to replace it.</p>
        </Confirm>)}
      {pending?.kind === "delete" && (
        <Confirm title={`Delete v${pending.v.seq}?`} confirmLabel="Delete" danger busy={busy} error={error} onCancel={() => setPending(null)} onConfirm={() => void confirm("")}>
          <p>"{pending.v.name}" and its numbers are removed for good. Archive it instead to keep it.</p>
        </Confirm>)}
    </div>
  );
}
