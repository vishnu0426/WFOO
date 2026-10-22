/**
 * The vendor catalogue for the Integration Station: each preset is a name plus its real, researched parameter set
 * and a default field map -- configuration, not code. Every preset resolves to one of the six generic delivery
 * methods in `engine.ts`; adding a vendor later means adding a row here, not writing a new adapter.
 *
 * Auth types and endpoints are the vendors' own documented shapes (Genesys OAuth2 client-credentials, Amazon
 * Connect SigV4, ADP mutual TLS, Workday ISU/OAuth, UKG's dual API-key header...). Field-map defaults are filled
 * where a vendor's schema is publicly documented; reason/state codes that are customer-specific are left for the
 * admin to complete during setup -- no preset can guess an org's own reason-code list.
 */
import { z } from 'zod';

export type Category = 'ACD' | 'CRM' | 'HRMS' | 'DATABASE' | 'ONPREM' | 'SFTP';
export type Method = 'API_PULL' | 'STREAM_SUBSCRIBE' | 'WEBHOOK' | 'ONPREM_RELAY' | 'DATABASE' | 'FILE_SFTP';
export type AuthType = 'API_KEY_HEADER' | 'BEARER_STATIC' | 'OAUTH2_CLIENT_CREDENTIALS' | 'AWS_SIGV4' | 'MUTUAL_TLS' | 'BASIC' | 'NONE';

export interface FieldSpec { key: string; label: string; kind: 'text' | 'password' | 'file' | 'select'; options?: string[]; help?: string; required?: boolean }
export interface DefaultMap { targetField: string; sourcePath: string; transform?: string }

export interface Preset {
  id: string; category: Category; method: Method; label: string; authType: AuthType;
  fields: FieldSpec[];              // exactly what the admin sees for this vendor -- the real parameters
  defaultMaps?: DefaultMap[];       // pre-filled field-map rows; state/reason left blank where vendor-agnostic
  writesTo: 'interval_history' | 'agent_state' | 'employees';
  note?: string;
}

const authField = (authType: AuthType): FieldSpec[] => {
  switch (authType) {
    case 'OAUTH2_CLIENT_CREDENTIALS': return [
      { key: 'clientId', label: 'Client ID', kind: 'text', required: true },
      { key: 'clientSecret', label: 'Client Secret', kind: 'password', required: true },
    ];
    case 'BEARER_STATIC': return [{ key: 'apiKey', label: 'API key', kind: 'password', required: true }];
    case 'API_KEY_HEADER': return [{ key: 'apiKey', label: 'API key', kind: 'password', required: true }, { key: 'headerName', label: 'Header name', kind: 'text', help: 'e.g. X-Api-Key' }];
    case 'BASIC': return [{ key: 'username', label: 'Username', kind: 'text', required: true }, { key: 'password', label: 'Password', kind: 'password', required: true }];
    case 'AWS_SIGV4': return [{ key: 'accessKeyId', label: 'Access key ID', kind: 'text', required: true }, { key: 'secretAccessKey', label: 'Secret access key', kind: 'password', required: true }, { key: 'roleArn', label: 'Role ARN (optional, instead of a key pair)', kind: 'text' }];
    case 'MUTUAL_TLS': return [{ key: 'clientId', label: 'Client ID', kind: 'text', required: true }, { key: 'clientSecret', label: 'Client Secret', kind: 'password', required: true }, { key: 'certificatePem', label: 'Signed certificate (.pem)', kind: 'file', required: true }, { key: 'privateKeyPem', label: 'Private key (.key)', kind: 'file', required: true }];
    default: return [];
  }
};

export const PRESETS: Preset[] = [
  // ---------------------------------------------------------------- ACD
  {
    id: 'GENESYS_CLOUD', category: 'ACD', method: 'API_PULL', label: 'Genesys Cloud', authType: 'OAUTH2_CLIENT_CREDENTIALS', writesTo: 'interval_history',
    fields: [...authField('OAUTH2_CLIENT_CREDENTIALS'), { key: 'region', label: 'Region', kind: 'select', options: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-2'], required: true }, { key: 'divisionId', label: 'Division ID', kind: 'text', help: 'Scopes which queues this connector can see' }],
    defaultMaps: [{ targetField: 'volume', sourcePath: 'nOffered' }, { targetField: 'ahtSec', sourcePath: 'tHandle' }, { targetField: 'abandoned', sourcePath: 'nAbandon' }],
    note: 'OAuth2 client-credentials grant; historical export is capped at ~6 weeks per request, chained for a deeper backfill.',
  },
  {
    id: 'AMAZON_CONNECT', category: 'ACD', method: 'API_PULL', label: 'Amazon Connect', authType: 'AWS_SIGV4', writesTo: 'interval_history',
    fields: [...authField('AWS_SIGV4'), { key: 'region', label: 'AWS region', kind: 'text', required: true }, { key: 'instanceId', label: 'Connect instance ID', kind: 'text', required: true }, { key: 'kinesisStreamName', label: 'Kinesis stream name (live agent events / CTRs)', kind: 'text' }],
    defaultMaps: [{ targetField: 'volume', sourcePath: 'Collections.CONTACTS_HANDLED.Value' }, { targetField: 'ahtSec', sourcePath: 'Collections.AVG_HANDLE_TIME.Value' }],
    note: 'Metrics via GetCurrentMetricData/GetMetricDataV2 (SigV4); live agent events/CTRs stream over Kinesis -- a distinct STREAM_SUBSCRIBE half, see ACD-AMAZON-STREAM.',
  },
  { id: 'ACD-AMAZON-STREAM', category: 'ACD', method: 'STREAM_SUBSCRIBE', label: 'Amazon Connect (live agent events)', authType: 'AWS_SIGV4', writesTo: 'agent_state', fields: authField('AWS_SIGV4').concat([{ key: 'region', label: 'AWS region', kind: 'text', required: true }, { key: 'kinesisStreamName', label: 'Kinesis stream name', kind: 'text', required: true }]), note: 'Forward-only: pairs with the AMAZON_CONNECT preset above for historical backfill.' },
  {
    id: 'NICE_CXONE', category: 'ACD', method: 'API_PULL', label: 'NICE CXone', authType: 'OAUTH2_CLIENT_CREDENTIALS', writesTo: 'interval_history',
    fields: [...authField('OAUTH2_CLIENT_CREDENTIALS'), { key: 'cluster', label: 'Regional cluster', kind: 'text', required: true, help: 'e.g. na1, eu1' }],
    defaultMaps: [{ targetField: 'volume', sourcePath: 'offered' }, { targetField: 'ahtSec', sourcePath: 'avgHandleTime' }],
  },
  {
    id: 'AVAYA_CMS', category: 'ACD', method: 'ONPREM_RELAY', label: 'Avaya CMS', authType: 'NONE', writesTo: 'interval_history',
    fields: [{ key: 'cmsHost', label: 'CMS host (for CMS to reach the connector)', kind: 'text', required: true }, { key: 'cmsRtaPort', label: 'RTA port', kind: 'text', required: true }, { key: 'informixHost', label: 'Informix host (historical JDBC/ODBC)', kind: 'text' }],
    note: 'Real-time: CMS opens a TCP connection out to the connector at this host:port. Historical: JDBC/ODBC against CMS\'s own Informix database. Wire-level parsing needs Avaya\'s own SDK -- see the plan\'s honesty note.',
  },
  {
    id: 'CISCO_UCCE', category: 'ACD', method: 'ONPREM_RELAY', label: 'Cisco UCCX / UCCE', authType: 'BASIC', writesTo: 'interval_history',
    fields: [...authField('BASIC'), { key: 'finesseHost', label: 'Finesse host', kind: 'text', required: true }, { key: 'awHdsDdsHost', label: 'AW-HDS-DDS host (historical)', kind: 'text' }],
    note: 'Agent state via Finesse REST; historical 15/30-min summaries via AW-HDS-DDS. Same on-prem relay shape as Avaya.',
  },
  {
    id: 'AGNOSHIN_NATS_RTA', category: 'ACD', method: 'STREAM_SUBSCRIBE', label: 'AgnoShin ACD (NATS agent state)', authType: 'BASIC', writesTo: 'agent_state',
    fields: [
      { key: 'natsServers', label: 'NATS servers', kind: 'text', required: true, help: 'Comma-separated, e.g. nats://192.168.9.81:4222' },
      { key: 'natsUser', label: 'NATS user', kind: 'text', required: true },
      { key: 'natsPass', label: 'NATS password', kind: 'password', required: true },
      { key: 'tlsRejectUnauthorized', label: 'Verify TLS certificate', kind: 'select', options: ['true', 'false'], help: 'false for a self-signed cluster cert' },
      { key: 'subject', label: 'Agent-state subject', kind: 'text', required: true, help: 'e.g. cc.acd.workspace.req.> (Workspace -> ACD requests, which is where EVT_AGENT_READY rides)' },
    ],
    note: 'Credentials and the request subject are confirmed (cc.acd.workspace.req.> / cc.acd.workspace.res). The subject carries every Workspace request, not just presence changes, and the payload shape is still unconfirmed -- one real sample of an EVT_AGENT_READY message is needed before the field map (and a filter for which messages are state changes at all) can be built. Not guessed at here.',
  },
  {
    id: 'AGNOSHIN_NATS_CDR', category: 'ACD', method: 'STREAM_SUBSCRIBE', label: 'AgnoShin ACD (NATS CDR/events)', authType: 'BASIC', writesTo: 'interval_history',
    fields: [
      { key: 'natsServers', label: 'NATS servers', kind: 'text', required: true, help: 'Comma-separated, e.g. nats://192.168.9.81:4222' },
      { key: 'natsUser', label: 'NATS user', kind: 'text', required: true },
      { key: 'natsPass', label: 'NATS password', kind: 'password', required: true },
      { key: 'tlsRejectUnauthorized', label: 'Verify TLS certificate', kind: 'select', options: ['true', 'false'], help: 'false for a self-signed cluster cert' },
      { key: 'subject', label: 'CDR/events subject', kind: 'text', required: true, help: 'The NATS subject VESL Service publishes CDR/events on' },
    ],
    note: 'Same cluster as AGNOSHIN_NATS_RTA, a separate subject for interval volume. Pairs with a DATABASE or API_PULL connector against workspace_admin for historical backfill.',
  },
  { id: 'GENERIC_ACD_API', category: 'ACD', method: 'API_PULL', label: 'Generic (has its own REST API)', authType: 'BEARER_STATIC', writesTo: 'interval_history', fields: [...authField('BEARER_STATIC'), { key: 'baseUrl', label: 'Base URL', kind: 'text', required: true }, { key: 'volumeEndpoint', label: 'Historical volume endpoint (path)', kind: 'text', required: true }], note: 'No defaults pre-filled -- map fields to your own response shape during setup.' },
  { id: 'GENERIC_ACD_RELAY', category: 'ACD', method: 'ONPREM_RELAY', label: 'Generic / custom or closed system', authType: 'NONE', writesTo: 'interval_history', fields: [], note: 'Nothing to call from our side. We issue an API key; your own team\'s connector reads your system and posts to our documented ingest endpoint.' },

  // ---------------------------------------------------------------- CRM
  {
    id: 'SALESFORCE', category: 'CRM', method: 'API_PULL', label: 'Salesforce Service Cloud Voice', authType: 'OAUTH2_CLIENT_CREDENTIALS', writesTo: 'agent_state',
    fields: [...authField('OAUTH2_CLIENT_CREDENTIALS'), { key: 'instanceUrl', label: 'Instance / My Domain URL', kind: 'text', required: true }, { key: 'runAsUsername', label: 'Run-as integration user', kind: 'text', required: true }],
    note: 'Presence via the Omni-Channel Toolkit / Platform Events -- also available as a WEBHOOK (Outbound Message / Flow HTTP callout), see SALESFORCE-WEBHOOK.',
  },
  { id: 'SALESFORCE-WEBHOOK', category: 'CRM', method: 'WEBHOOK', label: 'Salesforce (Outbound Message / Flow)', authType: 'NONE', writesTo: 'agent_state', fields: [], note: 'Salesforce POSTs to a URL and secret we generate on connector creation.' },
  { id: 'GENERIC_CRM_API', category: 'CRM', method: 'API_PULL', label: 'Generic CRM', authType: 'BEARER_STATIC', writesTo: 'agent_state', fields: [...authField('BEARER_STATIC'), { key: 'baseUrl', label: 'Base URL', kind: 'text', required: true }] },

  // ---------------------------------------------------------------- HRMS (employee/skill sync, not forecasting)
  {
    id: 'WORKDAY', category: 'HRMS', method: 'API_PULL', label: 'Workday', authType: 'BASIC', writesTo: 'employees',
    fields: [{ key: 'tenant', label: 'Tenant name', kind: 'text', required: true }, { key: 'isuUsername', label: 'Integration System User (format: user@tenant)', kind: 'text', required: true }, { key: 'isuPassword', label: 'ISU password', kind: 'password' }, { key: 'clientId', label: 'OAuth Client ID (alternative to ISU password)', kind: 'text' }, { key: 'clientSecret', label: 'OAuth Client Secret', kind: 'password' }, { key: 'refreshToken', label: 'OAuth refresh token', kind: 'password' }, { key: 'raasReportUrl', label: 'RaaS report URL', kind: 'text', required: true }],
    note: 'ISU username must include "@tenant" or Workday returns "Customer ID not specified". Report as a Service (RaaS) must be shared with the ISU and domain-permissioned for its fields.',
  },
  {
    id: 'ADP', category: 'HRMS', method: 'API_PULL', label: 'ADP', authType: 'MUTUAL_TLS', writesTo: 'employees',
    fields: authField('MUTUAL_TLS'),
    note: 'ADP requires mutual TLS, not just a client secret -- a private key and a certificate ADP signs, valid two years.',
  },
  {
    id: 'UKG_PRO', category: 'HRMS', method: 'API_PULL', label: 'UKG Pro', authType: 'API_KEY_HEADER', writesTo: 'employees',
    fields: [{ key: 'subdomain', label: 'Subdomain', kind: 'text', required: true, help: 'the "customer" in customer.ultipro.com' }, { key: 'customerApiKey', label: 'Customer API key', kind: 'password', required: true }, { key: 'userApiKey', label: 'User API key', kind: 'password', required: true }],
    note: 'Every request needs both a Bearer token and a US-API-Key header -- the two keys above.',
  },
  { id: 'BAMBOOHR', category: 'HRMS', method: 'API_PULL', label: 'BambooHR', authType: 'BEARER_STATIC', writesTo: 'employees', fields: [{ key: 'subdomain', label: 'Subdomain', kind: 'text', required: true }, { key: 'apiKey', label: 'API key', kind: 'password', required: true }] },
  { id: 'GENERIC_HRMS_API', category: 'HRMS', method: 'API_PULL', label: 'Generic HRMS', authType: 'BEARER_STATIC', writesTo: 'employees', fields: [...authField('BEARER_STATIC'), { key: 'baseUrl', label: 'Base URL', kind: 'text', required: true }] },

  // ---------------------------------------------------------------- Database (relay-family: the reader runs on the customer's side)
  { id: 'GENERIC_DATABASE', category: 'DATABASE', method: 'DATABASE', label: 'Oracle / SQL Server / Postgres / Informix', authType: 'NONE', writesTo: 'interval_history',
    fields: [{ key: 'engine', label: 'Database engine', kind: 'select', options: ['oracle', 'sqlserver', 'postgres', 'informix'], required: true }, { key: 'host', label: 'Host', kind: 'text', required: true }, { key: 'port', label: 'Port', kind: 'text', required: true }, { key: 'database', label: 'Database name', kind: 'text', required: true }, { key: 'table', label: 'Table / view', kind: 'text', required: true }, { key: 'watermarkColumn', label: 'Watermark column (e.g. updated_at)', kind: 'text', required: true }],
    note: 'No password stored here: the reader runs on the customer\'s own network against a read-only login they hold, not us reaching into their network.',
  },

  // ---------------------------------------------------------------- On-prem ACD (duplicated categorisation of AVAYA_CMS/CISCO_UCCE for the picker's ACD vs On-prem grouping)
  { id: 'GENERIC_ONPREM', category: 'ONPREM', method: 'ONPREM_RELAY', label: 'Generic / custom on-prem system', authType: 'NONE', writesTo: 'interval_history', fields: [], note: 'We issue an API key; your team\'s connector posts to our documented ingest endpoint.' },

  // ---------------------------------------------------------------- File/SFTP
  { id: 'GENERIC_SFTP', category: 'SFTP', method: 'FILE_SFTP', label: 'Scheduled export file', authType: 'NONE', writesTo: 'interval_history', fields: [{ key: 'direction', label: 'Who hosts the SFTP endpoint', kind: 'select', options: ['we_host', 'they_host'], required: true }, { key: 'remotePath', label: 'Remote path / filename pattern', kind: 'text' }] },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
export const presetsByCategory = (category: Category): Preset[] => PRESETS.filter((p) => p.category === category);

/** Runtime validation of a connector's `config` against its preset's real fields -- required ones must be present. */
export function configSchemaFor(preset: Preset) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of preset.fields) shape[f.key] = f.required ? z.string().min(1, `${f.label} is required`) : z.string().optional();
  return z.object(shape).passthrough();
}
