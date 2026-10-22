/**
 * Shared frame for the forecasting screens that follow the reference design (Adjustments, Scenarios, Models, Staffing):
 * a page header with the forecast's status, a toolbar that picks the group, type and forecast, and the empty states.
 * Also the few form controls those screens need, in the same look as the toolbar.
 */
import React from "react";
import { STATUS_LABEL, isNew } from "../../services/api";
import { useForecast } from "../../services/forecastStore";
import { Empty } from "./ui";
import { PageHeader, Select, StatusPill, Toolbar } from "../wfm/app-shell";

export function RefScope({ crumb, title, description, actions, toolbar, needs = "forecast", emptyHint, children }: {
  crumb: string; title: string; description: string; actions?: React.ReactNode; toolbar?: React.ReactNode; needs?: "forecast" | "group"; emptyHint?: string; children: (v: NonNullable<ReturnType<typeof useForecast>["version"]>) => React.ReactNode;
}) {
  const { groups, group, setGroupId, versions, version, setVersionId, kind, setKind, go, can } = useForecast();
  if (!group) return null;
  const header = (
    <PageHeader breadcrumb={["Forecasting", crumb]} title={title} description={description}
      actions={<>{version && <StatusPill status={version.status} />}{actions}</>} />
  );
  const scope = (
    <Toolbar>
      <Select label="Group" value={group.id} options={groups.map((g) => ({ id: g.id, label: g.name }))} onChange={(id) => setGroupId(id)} />
      <Select label="Type" value={kind} options={[{ id: "SHORT", label: "Short-term" }, { id: "LONG", label: "Long-term" }]} onChange={(k) => setKind(k as "SHORT" | "LONG")} />
      {version && (
        <Select label="Forecast" value={version.id}
          options={versions.filter((v) => v.kind === kind).map((v) => ({ id: v.id, label: `${v.status === "PUBLISHED" ? "● " : ""}${v.name} — ${STATUS_LABEL[v.status].toLowerCase()}${isNew(v) ? " — NEW" : ""}` }))}
          onChange={(id) => setVersionId(id)} />
      )}
      {toolbar}
    </Toolbar>
  );
  if (!version) {
    return (
      <div>
        {header}{scope}
        <div className="p-6">
          <Empty title={`No ${kind === "SHORT" ? "short-term" : "long-term"} forecast for ${group.name} yet`}>
            {emptyHint ?? "Create one in Forecast Builder from your interval history."}
            {can("forecast:create") && <div className="mt-3"><button className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground" onClick={() => go("forecast-builder")}>Open Forecast Builder</button></div>}
          </Empty>
        </div>
      </div>
    );
  }
  return <div>{header}{scope}{children(version)}</div>;
}

export const fieldCls = "h-9 w-full rounded-lg border bg-background px-3 text-[13px] outline-none focus:border-foreground disabled:opacity-60";

export function Labeled({ label, hint, children, className = "" }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-[12px] font-medium text-subtle-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-subtle-foreground">{hint}</span>}
    </label>
  );
}

export function Segmented({ options, value, onChange, disabled }: { options: { id: string; label: string }[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex h-9 rounded-lg border bg-background p-0.5" role="group">
      {options.map((o) => (
        <button key={o.id} type="button" disabled={disabled} onClick={() => onChange(o.id)}
          className={`rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-60 ${value === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function Notice({ kind, children, onClose }: { kind: "err" | "info" | "ok" | "warn"; children: React.ReactNode; onClose?: () => void }) {
  const tone = kind === "err" ? "bg-critical-bg text-critical" : kind === "ok" ? "bg-success-bg text-success" : kind === "warn" ? "bg-warning-bg text-warning" : "bg-info-bg text-info";
  return (
    <div className={`mx-6 my-3 flex items-start justify-between gap-3 rounded-md px-3.5 py-2.5 text-[13px] ${tone}`}>
      <div>{children}</div>
      {onClose && <button onClick={onClose} className="shrink-0 text-[11px] underline">Dismiss</button>}
    </div>
  );
}

/** A plain reference-style table: header row on the surface colour, rows separated by borders. */
export function RefTable({ head, right = [], children }: { head: string[]; right?: number[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="num w-full text-[13px]">
        <thead className="border-y bg-surface text-left text-[12px] text-subtle-foreground">
          <tr>{head.map((h, i) => <th key={h + i} className={`px-6 py-2 font-medium ${right.includes(i) ? "text-right" : ""}`}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
