/**
 * The forecast lifecycle as handlers: Draft -> Submitted -> Approved -> Published (older published versions become Archived),
 * plus clone, delete and the full CSV export. Which actions are offered follows the signed-in user's permissions; the gateway
 * enforces them again. Used by the dashboard header (the older sections keep the VersionBar).
 */
import { useState } from "react";
import { api, download } from "../../services/api";
import { useForecast } from "../../services/forecastStore";

export function useVersionActions() {
  const { version, reload, can, setVersionId, setNotice } = useForecast();
  const [busy, setBusy] = useState(false);
  const st = version?.status;

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true); setNotice(null);
    try { await fn(); if (ok) setNotice({ kind: "ok", text: ok }); } catch (e: any) { setNotice({ kind: "err", text: e.message }); } finally { setBusy(false); }
  };
  const step = (path: string, ok: string, askReason?: string) => run(async () => {
    const body: any = {};
    if (askReason) {
      const r = prompt(askReason);
      if (!r || r.trim().length < 3) throw new Error("A reason is required");
      body.reason = r.trim();
    }
    await api(`/forecast/versions/${version!.id}/${path}`, { method: "POST", body });
    await reload(version!.id);
  }, ok);

  const canReturn = can("forecast:approve") || can("forecast:submit");
  return {
    busy, status: st,
    submit: can("forecast:submit") && st === "DRAFT" ? () => step("submit", "Submitted for approval. It is now locked: approve it, or return it to draft.") : null,
    approve: can("forecast:approve") && st === "SUBMITTED" ? () => step("approve", "Approved. Publish it to drive the schedule.") : null,
    publish: can("forecast:publish") && st === "APPROVED" ? () => step("publish", "Published. Staffing coverage and the auto-scheduler now use this forecast.") : null,
    returnToDraft: canReturn && (st === "SUBMITTED" || st === "APPROVED") ? () => step("reject", "Returned to draft.", "Why is it being returned to draft?") : null,
    clone: can("forecast:create") && (st === "PUBLISHED" || st === "ARCHIVED")
      ? () => run(async () => { const v = await api(`/forecast/versions/${version!.id}/clone`, { method: "POST" }); await reload(v.id); }, "Draft copy created. Adjust it, then submit it for approval.") : null,
    remove: can("forecast:delete") && version && st !== "PUBLISHED"
      ? () => { if (!confirm(`Delete "${version!.name}"?`)) return; run(async () => { await api(`/forecast/versions/${version!.id}`, { method: "DELETE" }); setVersionId(null); await reload(); }, "Forecast deleted."); } : null,
    exportAll: version ? () => run(() => download(`/forecast/versions/${version.id}/export.csv`, `forecast-v${version.seq}.csv`)) : null,
  };
}

