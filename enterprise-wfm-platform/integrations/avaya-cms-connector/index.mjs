#!/usr/bin/env node
/**
 * Avaya CMS on-prem relay. Two halves, honestly split:
 *
 *  1. THE RELAY-OUT HALF IS REAL: `postLive` / `postBackfill` below are the exact same working code the
 *     database-reader and sftp-poller scripts use, calling our documented, already-live ingest endpoints.
 *  2. THE CMS PROTOCOL HALF IS A PLACEHOLDER: `readCmsHistorical` (JDBC/ODBC against CMS's own Informix database)
 *     and `listenCmsRealTime` (CMS opens a TCP connection to `--listen-port` on this machine and streams state-change
 *     records -- see run.md's Integration Station research) need Avaya's own CMS SDK / developer materials to
 *     implement correctly. I do not have access to that documentation in this environment, so the exact byte-level
 *     record format is not guessed at here -- see the plan's honesty note. What CMS needs from you to make the
 *     real-time half work: point CMS's Real-Time Adherence (Generic-RTA) feature at this machine's host and
 *     `--listen-port`; CMS makes the connection, not you.
 *
 * Usage once the CMS-side functions are filled in:
 *   node index.mjs --gateway http://localhost:4000 --connector <id> --key <api-key> \
 *     --informix "..." --listen-port 5000 --through 2026-01-31
 */
import net from 'node:net';

function args() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
  return a;
}

// ---------------------------------------------------------------- the real, working relay-out half

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

// ---------------------------------------------------------------- the CMS-specific half: fill in against Avaya's own SDK

/** TODO: query CMS's Informix database (JDBC/ODBC) for the historical range and return plain row objects. */
async function readCmsHistorical(_informixConnStr, _through) {
  throw new Error('Not implemented: needs Avaya\'s CMS Informix schema documentation (their own SDK/developer materials).');
}

/** TODO: parse CMS's Real-Time Adherence (Generic-RTA) TCP stream into {employeeNumber, state, reason, at} records. */
function listenCmsRealTime(listenPort, onEvents) {
  const server = net.createServer((socket) => {
    console.log(`CMS connected from ${socket.remoteAddress}`);
    socket.on('data', (_chunk) => {
      // TODO: parse Avaya's RTA wire format here, then: onEvents([{ employeeNumber, state, reason, at }, ...]);
      console.warn('Received data from CMS but the RTA record parser is not implemented -- see the header comment.');
    });
  });
  server.listen(listenPort, () => console.log(`Listening on port ${listenPort} for CMS to connect (point CMS\'s RTA feed at this host:port).`));
  return server;
}

async function main() {
  const o = args();
  for (const k of ['gateway', 'connector', 'key']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
  if (o.through) {
    const rows = await readCmsHistorical(o.informix, o.through); // will throw until the TODO above is implemented
    const out = await postBackfill(o.gateway, o.connector, o.key, o.through, rows);
    console.log(`Backfilled ${out.rowsMapped} row(s).`);
  }
  if (o['listen-port']) {
    listenCmsRealTime(Number(o['listen-port']), async (events) => {
      const out = await postLive(o.gateway, o.connector, o.key, events);
      console.log(`Relayed ${events.length} event(s), accepted ${out.accepted}.`);
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
