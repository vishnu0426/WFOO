/**
 * The page building blocks the reference screens import from "@/components/wfm/app-shell":
 * PageHeader, Toolbar, Select, Metric, Section and StatusPill. Written from how those screens use them, on the design tokens
 * in index.css (bg-surface, text-subtle-foreground, border-border-strong, text-success, ...). Wrap a screen in `.ref-ui`
 * so every border picks up --color-border, as in the reference stylesheet.
 */
import React from "react";
import { CalendarDays, ListChecks, SlidersHorizontal } from "lucide-react";
import { STATUS_LABEL, type VersionStatus } from "../../services/api";

export function PageHeader({ breadcrumb, title, description, actions }: { breadcrumb: string[]; title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="border-b px-6 pb-5 pt-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <nav className="text-[12px] text-muted-foreground">
            {breadcrumb.map((b, i) => (
              <span key={b}>
                {i > 0 && <span className="mx-1.5">/</span>}
                {b}
              </span>
            ))}
          </nav>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-tight">{title}</h1>
          {description && <p className="mt-1.5 max-w-3xl text-[14px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 border-b bg-surface px-6 py-3 text-[13px]">{children}</div>;
}

/** A labelled dropdown for the toolbar. Options are plain strings, or { id, label } when the value differs from the text. */
export function Select({ label, value, options, onChange, disabled }: { label: string; value: string; options: (string | { id: string; label: string })[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3">
      <SlidersHorizontal className="size-3.5 text-subtle-foreground" />
      <span className="text-subtle-foreground">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} className="max-w-[220px] bg-transparent font-medium outline-none">
        {options.map((o) => {
          const id = typeof o === "string" ? o : o.id;
          return <option key={id} value={id}>{typeof o === "string" ? o : o.label}</option>;
        })}
      </select>
    </label>
  );
}

/** A labelled date box for the toolbar. */
export function DateField({ label, value, min, max, onChange }: { label: string; value: string; min?: string; max?: string; onChange: (v: string) => void }) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3">
      <CalendarDays className="size-3.5 text-subtle-foreground" />
      <span className="text-subtle-foreground">{label}</span>
      <input type="date" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label={label} className="bg-transparent font-medium outline-none" />
    </label>
  );
}

const TONE = { success: "text-success", warning: "text-warning", critical: "text-critical" } as const;

export function Metric({ label, value, hint, delta, tone, title }: { label: string; value: React.ReactNode; hint?: string; delta?: string; tone?: keyof typeof TONE; title?: string }) {
  return (
    <div className="num px-6 py-4" title={title}>
      <div className="flex items-center gap-2 text-[13px] text-subtle-foreground"><ListChecks className="size-3.5" />{label}</div>
      <div className="mt-2 text-[26px] font-semibold leading-none">{value}</div>
      {delta ? <div className={`mt-2 text-[13px] ${tone ? TONE[tone] : "text-muted-foreground"}`}>{delta}</div> : hint ? <div className="mt-2 text-[13px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Section({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-3 pt-5">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const PILL: Record<VersionStatus, string> = {
  DRAFT: "bg-surface-subtle text-muted-foreground",
  SUBMITTED: "bg-warning-bg text-warning",
  APPROVED: "bg-info-bg text-info",
  PUBLISHED: "bg-success-bg text-success",
  ARCHIVED: "bg-surface-subtle text-subtle-foreground",
};
export function StatusPill({ status }: { status: VersionStatus }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${PILL[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function PrimaryButton({ className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={`flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[14px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 ${className}`} />;
}
export function OutlineButton({ className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={`flex h-9 items-center gap-1.5 rounded-md border px-3 text-[14px] font-medium transition-colors hover:bg-surface disabled:opacity-50 ${className}`} />;
}
