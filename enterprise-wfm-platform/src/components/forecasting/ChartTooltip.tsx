/**
 * The reference chart tooltip (recharts): the label, then one "name  value" row for every series that has a value.
 * `extra` adds an optional line under the rows (used for "Adjusted by a planner").
 */
import React from "react";

export function ChartTooltip({ active, payload, label, extra }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload ?? {};
  const note = extra ? extra(point) : null;
  return (
    <div className="num rounded-md border bg-popover px-3 py-2 text-[12px] shadow-sm">
      <div className="mb-1 font-semibold">{label}</div>
      {payload
        .filter((p: any) => p.value !== null && p.value !== undefined)
        .map((p: any) => (
          <div key={p.dataKey} className="flex items-center justify-between gap-6">
            <span className="capitalize text-muted-foreground">{String(p.dataKey).replace(/([A-Z])/g, " $1")}</span>
            <span className="font-medium">{typeof p.value === "number" ? Math.round(p.value) : p.value}</span>
          </div>
        ))}
      {note && <div className="mt-1 text-warning">{note}</div>}
    </div>
  );
}
