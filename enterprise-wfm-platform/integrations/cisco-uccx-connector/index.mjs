#!/usr/bin/env node
/**
 * Cisco UCCX/UCCE on-prem relay. Same honest split as the Avaya connector next to this one:
 *
 *  1. THE RELAY-OUT HALF IS REAL: identical working code to the other relay-family scripts, calling our documented,
 *     already-live ingest endpoints.
 *  2. THE CISCO PROTOCOL HALF IS A PLACEHOLDER: `readAwHdsDds` (the AW-HDS-DDS historical database) and
 *     `pollFinesseAgentState` (Finesse's own REST API for live agent state) need Cisco's own Finesse/UCCE developer
 *     resources to implement correctly -- not guessed at here. See the plan's honesty note.
 *
 * Usage once the Cisco-side functions are filled in:
 *   node index.mjs --gateway http://localhost:4000 --connector <id> --key <api-key> \
 *     --finesse-host uccx.example.com --finesse-user svc --finesse-password *** --through 2026-01-31
 */
function args() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
  return a;
}

// ---------------------------------------------------------------- the real, working relay-out half (identical pattern to avaya-cms-connector)

async function postLive(gateway, connectorId, key, rows) {
  const res = await fetch(`${gateway}/api/v1/integrations/${connectorId}/live`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ rows }) });
  if (!res.ok) throw new Error(`live post failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function postBackfill(gateway, connectorId, key, through, rows) {
  const res = await fetch(`${gateway}/api/v1/integrations/${connectorId}/backfill`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ rows, through }) });
  if (!res.ok) throw new Error(`backfill post failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------- the Cisco-specific half: fill in against Cisco's own developer resources

/** TODO: query the AW-HDS-DDS database for 15/30-min interval summaries over the historical range. */
async function readAwHdsDds(_host, _through) {
  throw new Error('Not implemented: needs Cisco\'s AW-HDS-DDS schema documentation.');
}

/** TODO: poll (or subscribe to) Finesse's REST API for current agent state and translate it into {employeeNumber, state, reason, at}. */
async function pollFinesseAgentState(_finesseHost, _user, _password) {
  throw new Error('Not implemented: needs Cisco\'s Finesse API developer documentation.');
}

async function main() {
  const o = args();
  for (const k of ['gateway', 'connector', 'key']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
  if (o.through) {
    const rows = await readAwHdsDds(o['finesse-host'], o.through);
    const out = await postBackfill(o.gateway, o.connector, o.key, o.through, rows);
    console.log(`Backfilled ${out.rowsMapped} row(s).`);
  }
  if (o.poll) {
    const events = await pollFinesseAgentState(o['finesse-host'], o['finesse-user'], o['finesse-password']);
    const out = await postLive(o.gateway, o.connector, o.key, events);
    console.log(`Relayed ${events.length} event(s), accepted ${out.accepted}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
