/**
 * How far each provider has actually been proven, shown as a badge on the Integration Station so nobody mistakes a setup form for a
 * working integration. Kept in one table (not scattered over the presets) so it can be read and corrected in one place, and a test
 * fails if a preset is added without an entry here.
 *
 *   VERIFIED  ran against a real system and moved real data
 *   TESTED    works end to end against our own test servers or a standard protocol, not against the vendor
 *   FROM_DOCS built from the vendor's published documents; not run against the vendor
 *   NOT_READY a setup form only, or the part that reads the vendor is missing
 */
export type Readiness = 'VERIFIED' | 'TESTED' | 'FROM_DOCS' | 'NOT_READY';
export interface ReadinessInfo { level: Readiness; label: string; note: string }

export const READINESS_LABEL: Record<Readiness, string> = { VERIFIED: 'Verified', TESTED: 'Tested', FROM_DOCS: 'Built from docs', NOT_READY: 'Not ready' };

const r = (level: Readiness, note: string): ReadinessInfo => ({ level, label: READINESS_LABEL[level], note });

const TABLE: Record<string, ReadinessInfo> = {
  AGNOSHIN_NATS_RTA: r('VERIFIED', 'Has received live agent events from a real AgnoShin cluster. Login and logout types still need a state chosen under RTA State Mapping.'),
  DATABASE_POSTGRES_PULL: r('VERIFIED', 'Run against a real PostgreSQL database, read-only, with a row cap.'),

  GENERIC_ACD_API: r('TESTED', 'Pulls any REST source you describe. Tested against a stand-in server, not a particular vendor.'),
  GENERIC_SFTP: r('TESTED', 'Picks up CSV files from an SFTP folder. Tested with a stand-in server.'),
  GENERIC_DATABASE: r('TESTED', 'The on-site reader is tested against PostgreSQL. Other engines change only the driver and have not been run.'),
  GENERIC_ACD_RELAY: r('TESTED', 'Your own connector posts to our documented endpoint, which is tested.'),
  GENERIC_ONPREM: r('TESTED', 'Your own connector posts to our documented endpoint, which is tested.'),
  'SALESFORCE-WEBHOOK': r('TESTED', 'Receiving and checking the signed call is tested. Not run against Salesforce itself.'),

  AVAYA_AACC: r('FROM_DOCS', 'Reader and checks are tested against a stand-in database. Column names are unconfirmed until run against a real AACC, and there is no live agent state.'),
  GENESYS_CLOUD: r('FROM_DOCS', 'Sign-in follows Genesys documentation. Scheduled pulls are not available yet; use the on-site relay or a webhook.'),
  AMAZON_CONNECT: r('FROM_DOCS', 'Request signing is checked against AWS test vectors. Scheduled pulls are not available yet.'),
  NICE_CXONE: r('FROM_DOCS', 'Sign-in follows NICE documentation. Scheduled pulls are not available yet.'),

  AVAYA_CMS: r('NOT_READY', 'The part that reads Avaya CMS is not written; it needs Avaya\'s own materials.'),
  CISCO_UCCE: r('NOT_READY', 'The part that reads Finesse and the historical database is not written.'),
  AGNOSHIN_NATS_CDR: r('NOT_READY', 'The call-record subject and message shape have not been confirmed.'),
  'ACD-AMAZON-STREAM': r('NOT_READY', 'Live Kinesis reading is not built.'),
  SALESFORCE: r('NOT_READY', 'Presence pulls are not built; use the Salesforce webhook.'),
  GENERIC_CRM_API: r('NOT_READY', 'Scheduled CRM pulls are not built.'),
  WORKDAY: r('NOT_READY', 'Employee sync is not wired up yet.'),
  ADP: r('NOT_READY', 'Employee sync is not wired up yet.'),
  UKG_PRO: r('NOT_READY', 'Employee sync is not wired up yet.'),
  BAMBOOHR: r('NOT_READY', 'Employee sync is not wired up yet.'),
  GENERIC_HRMS_API: r('NOT_READY', 'Employee sync is not wired up yet.'),
};

/** A provider nobody has classified is shown as not ready, never as working. */
export const readinessOf = (presetId: string): ReadinessInfo => TABLE[presetId] ?? r('NOT_READY', 'Not yet assessed.');
export const hasReadiness = (presetId: string) => presetId in TABLE;
