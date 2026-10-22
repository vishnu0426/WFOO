/**
 * Forecasts: the reference screen (header, toolbar with search and filters, plain table) listing every forecast version across
 * the WFM groups from /forecast/versions. History is never overwritten: each change is a new numbered version.
 * Click a forecast to open it on the dashboard.
 */
import React, { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { CHANNEL_LABEL, dayYear, isNew, MODEL_LABEL, STATUS_LABEL, type VersionMeta, type VersionStatus, when } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { useApi } from "./hooks";
import { Empty } from "./ui";
import { PageHeader, PrimaryButton, Select, StatusPill, Toolbar } from "../wfm/app-shell";

const updated = (v: VersionMeta) => [v.publishedAt, v.approvedAt, v.submittedAt, v.createdAt].filter(Boolean).sort().at(-1) as string;

export function ForecastsSection() {
  const { groups, group, setGroupId, setVersionId, go, can } = useForecast();
  const all = useApi<VersionMeta[]>("/forecast/versions");
  const [status, setStatus] = useState("All statuses");
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");
  const gname = (id: string) => groups.find((g) => g.id === id)?.name ?? "–";
  const channels = (id: string) => [...new Set(groups.find((g) => g.id === id)?.queues.map((q) => CHANNEL_LABEL[q.channel] ?? q.channel) ?? [])].join(", ") || "–";

  const rows = useMemo(() => (all.data ?? []).filter((f) =>
    (status === "All statuses" || f.status === status.toUpperCase()) &&
    (!groupFilter || f.wfmGroupId === groupFilter) &&
    (f.name.toLowerCase().includes(query.toLowerCase()) || `v${f.seq}`.includes(query.toLowerCase()) || gname(f.wfmGroupId).toLowerCase().includes(query.toLowerCase()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ).sort((a, b) => updated(b).localeCompare(updated(a))), [all.data, status, groupFilter, query, groups]);

  const open = (v: VersionMeta) => {
    if (group?.id === v.wfmGroupId) setVersionId(v.id); else setGroupId(v.wfmGroupId, v.id);
    go("forecast-dashboard");
  };

  return (
    <div>
      <PageHeader
        breadcrumb={["Forecasting", "Forecasts"]}
        title="Forecasts"
        description="Forecast history is never overwritten — each change creates a new version."
        actions={can("forecast:create") && (
          <PrimaryButton onClick={() => go("forecast-builder")}><Plus className="size-3.5" /> New forecast</PrimaryButton>
        )}
      />
      <Toolbar>
        <label className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1">
          <Search className="size-3.5 text-subtle-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search forecasts" aria-label="Search forecasts" className="w-56 bg-transparent text-[13px] outline-none" />
        </label>
        <Select label="Status" value={status} onChange={setStatus} options={["All statuses", ...(Object.keys(STATUS_LABEL) as VersionStatus[]).map((s) => STATUS_LABEL[s])]} />
        <Select label="Group" value={groupFilter} onChange={setGroupFilter} options={[{ id: "", label: "All groups" }, ...groups.map((g) => ({ id: g.id, label: g.name }))]} />
        <span className="num ml-auto text-subtle-foreground">{rows.length} forecast{rows.length === 1 ? "" : "s"}</span>
      </Toolbar>

      {all.error && <p className="px-6 py-3 text-[13px] text-critical">{all.error}</p>}
      {(all.data?.length ?? 0) === 0 && !all.loading ? (
        <div className="p-6"><Empty title="No forecasts yet">Create the first one in Forecast Builder once interval history is imported.</Empty></div>
      ) : (
        <table className="num w-full text-[13px]">
          <thead className="border-b bg-surface text-left text-[12px] text-subtle-foreground">
            <tr>
              {["Forecast", "Group", "Channel", "Interval", "Horizon", "Model", "WAPE", "Status", "Ver.", "Owner", "Updated"].map((h) => (
                <th key={h} className="px-6 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const wape = f.wape == null ? null : f.wape * 100;
              return (
                <tr key={f.id} className="cursor-pointer border-b transition-colors hover:bg-surface" onClick={() => open(f)}>
                  <td className="px-6 py-3">
                    <button className="font-medium hover:underline" onClick={(e) => { e.stopPropagation(); open(f); }}>{f.name}</button>
                    {isNew(f) && <span className="ml-2 rounded-full bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">NEW</span>}
                    <div className="text-[12px] text-subtle-foreground">{f.kind === "SHORT" ? "Short-term" : "Long-term"}</div>
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{gname(f.wfmGroupId)}</td>
                  <td className="px-6 py-3 text-muted-foreground">{channels(f.wfmGroupId)}</td>
                  <td className="px-6 py-3">{f.kind === "SHORT" ? "15 min" : "Daily"}</td>
                  <td className="px-6 py-3 text-muted-foreground">{dayYear(f.fromDay)} → {dayYear(f.toDay)}</td>
                  <td className="px-6 py-3">{f.model ? (f.model === "mixed" ? "Mixed by queue" : MODEL_LABEL[f.model] ?? f.model) : "–"}</td>
                  <td className={`px-6 py-3 font-medium ${wape === null ? "text-subtle-foreground" : wape < 7 ? "text-success" : wape < 9 ? "text-warning" : "text-critical"}`}>
                    {wape === null ? "–" : `${wape.toFixed(1)}%`}
                  </td>
                  <td className="px-6 py-3"><StatusPill status={f.status} /></td>
                  <td className="px-6 py-3 text-muted-foreground">v{f.seq}</td>
                  <td className="px-6 py-3 text-muted-foreground">{f.createdBy ?? "–"}</td>
                  <td className="px-6 py-3 text-subtle-foreground">{when(updated(f))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
