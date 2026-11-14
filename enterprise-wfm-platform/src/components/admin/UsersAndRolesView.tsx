/**
 * Administration > Users and Roles. Real accounts from the `users` table and the role -> permission matrix from
 * `role_permissions` (seeded from DEFAULT_PERMISSIONS, editable per tenant). WFM_ADMIN always keeps users:read and
 * users:write, and nobody can change their own role or disable their own account — the gateway enforces both.
 */
import { Waiting, LoadFailed } from '../common/loading';
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { api, LicenseUsageReport } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

type WUser = { id: string; username: string; userName: string; email: string | null; role: string; status: 'ACTIVE' | 'DISABLED'; employeeId: string | null; createdAt: string; lastLoginAt: string | null; access?: string };
type Access = { restricted: boolean; regions: { id: string; name: string }[]; sites: { id: string; name: string }[] };
type Matrix = { roles: string[]; permissions: string[]; matrix: Record<string, string[]>; defaults: Record<string, string[]> };

const ROLE_LABEL: Record<string, string> = { WFM_ADMIN: 'Admin', WFM_MANAGER: 'Manager', FORECAST_PLANNER: 'Planner', SCHEDULER: 'Scheduler', SUPERVISOR_RTA: 'Supervisor', ANALYST: 'Analyst', AGENT: 'Agent' };
const PERM_LABEL: Record<string, string> = {
  'config:read': 'View configuration', 'config:write': 'Change configuration',
  'data:read': 'View imported data', 'data:import': 'Import interval history', 'data:rollback': 'Roll back an import',
  'forecast:read': 'View forecasts', 'forecast:create': 'Create forecasts', 'forecast:adjust': 'Adjust and apply scenarios',
  'forecast:submit': 'Submit for approval', 'forecast:approve': 'Approve forecasts', 'forecast:publish': 'Publish forecasts', 'forecast:delete': 'Delete forecasts',
  'workforce:read': 'View employees and teams', 'workforce:write': 'Edit employees and teams',
  'schedule:read': 'View schedules', 'schedule:generate': 'Generate a schedule', 'schedule:edit': 'Manually edit a schedule', 'schedule:approve': 'Approve a schedule', 'schedule:publish': 'Publish a schedule',
  'requests:approve': "Decide their own team's time off and swaps", 'intraday:read': 'View intraday and RTA', 'intraday:act': 'Act on intraday recommendations',
  'audit:read': 'View the audit log', 'users:read': 'View users and roles', 'users:write': 'Manage users and role permissions',
  'self:use': 'Use the self-service app',
};
const CATEGORY_LABEL: Record<string, string> = { config: 'Configuration', data: 'Data imports', forecast: 'Forecasting', workforce: 'Workforce', schedule: 'Scheduling', intraday: 'Intraday & RTA', audit: 'Audit', users: 'Users & roles', self: 'Self-service' };
const prettify = (perm: string) => PERM_LABEL[perm] ?? perm.replace(':', ': ');

interface UsersAndRolesViewProps { activeSubSection?: string }

export const UsersAndRolesView: React.FC<UsersAndRolesViewProps> = ({ activeSubSection = 'users' }) => {
  const { can, session } = useForecast();
  const canWrite = can('users:write');
  const [tab, setTab] = useState<'USERS' | 'RBAC'>(activeSubSection === 'roles' ? 'RBAC' : 'USERS');
  useEffect(() => setTab(activeSubSection === 'roles' ? 'RBAC' : 'USERS'), [activeSubSection]);
  const [tick, setTick] = useState(0);
  const users = useApi<WUser[]>('/users', [tick]);
  const rbac = useApi<Matrix>('/rbac/matrix', [tick]);
  const licenseReq = useApi<LicenseUsageReport>('/license', [tick]);
  const userCap = licenseReq.data?.capacity?.users;
  const atUserCap = !!userCap && userCap.remaining <= 0;
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  const orgSites = useApi<{ id: string; name: string; status: string; regionName: string | null }[]>('/config/sites');
  const orgRegions = useApi<{ id: string; name: string }[]>('/config/regions');
  const roles = rbac.data?.roles ?? Object.keys(ROLE_LABEL);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', email: '', role: '', password: '' });
  useEffect(() => { if (roles.length && !form.role) setForm((f) => ({ ...f, role: roles[0] })); }, [roles.join(',')]);

  const createUser = () => run(async () => {
    await api('/users', { method: 'POST', body: { username: form.username, displayName: form.displayName, email: form.email || undefined, role: form.role, password: form.password } });
    setForm({ username: '', displayName: '', email: '', role: roles[0] ?? '', password: '' });
    setShowNew(false); setNotice('User created.');
  });

  const [editId, setEditId] = useState<string | null>(null);
  const editing = users.data?.find((u) => u.id === editId) ?? null;
  const [edit, setEdit] = useState({ role: '', status: 'ACTIVE' as WUser['status'], password: '' });
  useEffect(() => { if (editing) setEdit({ role: editing.role, status: editing.status, password: '' }); }, [editing?.id]);
  const isSelf = editing?.id === session.user.id;
  // access: the whole organisation, or only some regions and sites
  const [only, setOnly] = useState(false);
  const [pickRegions, setPickRegions] = useState<string[]>([]);
  const [pickSites, setPickSites] = useState<string[]>([]);
  useEffect(() => {
    if (!editId) return;
    api<Access>(`/users/${editId}/access`).then((a) => { setOnly(a.restricted); setPickRegions(a.regions.map((x) => x.id)); setPickSites(a.sites.map((x) => x.id)); }).catch(() => {});
  }, [editId]);
  const saveAccess = () => editing && run(async () => {
    await api(`/users/${editing.id}/access`, { method: 'PUT', body: only ? { regionIds: pickRegions, siteIds: pickSites } : { regionIds: [], siteIds: [] } });
    setNotice(only ? 'Access saved. They now see only those sites and regions.' : 'Access saved. They see the whole organisation.');
  });
  const accessChanged = !!editing && (only !== !!editing.access || only);
  const noneChosen = only && pickRegions.length === 0 && pickSites.length === 0;
  const saveEdit = () => editing && run(async () => {
    const body: any = {};
    if (!isSelf && edit.role !== editing.role) body.role = edit.role;
    if (!isSelf && edit.status !== editing.status) body.status = edit.status;
    if (edit.password) body.password = edit.password;
    if (Object.keys(body).length === 0) { setEditId(null); return; }
    await api(`/users/${editing.id}`, { method: 'PATCH', body });
    setEditId(null); setNotice('User updated.');
  });

  // RBAC: work on a local copy, save one role at a time
  const [work, setWork] = useState<Record<string, Set<string>> | null>(null);
  useEffect(() => { if (rbac.data) setWork(Object.fromEntries(rbac.data.roles.map((r) => [r, new Set(rbac.data!.matrix[r] ?? [])]))); }, [rbac.data]);
  const grouped = useMemo(() => {
    const perms = rbac.data?.permissions ?? [];
    const byCat = new Map<string, string[]>();
    for (const p of perms) { const cat = p.split(':')[0]; byCat.set(cat, [...(byCat.get(cat) ?? []), p]); }
    return [...byCat.entries()];
  }, [rbac.data?.permissions]);
  const toggle = (role: string, perm: string) => {
    if (!work) return;
    if (role === 'WFM_ADMIN' && (perm === 'users:read' || perm === 'users:write')) return; // admin must keep both
    setWork((w) => { const s = new Set(w![role]); s.has(perm) ? s.delete(perm) : s.add(perm); return { ...w!, [role]: s }; });
  };
  const dirty = (role: string) => !!work && !!rbac.data && JSON.stringify([...work[role]].sort()) !== JSON.stringify([...(rbac.data.matrix[role] ?? [])].sort());
  const saveRole = (role: string) => work && run(async () => { await api(`/rbac/matrix/${role}`, { method: 'PUT', body: { permissions: [...work[role]] } }); setNotice(`${ROLE_LABEL[role] ?? role} permissions saved.`); });
  const resetRole = (role: string) => rbac.data && setWork((w) => ({ ...w!, [role]: new Set(rbac.data!.matrix[role] ?? []) }));

  if (users.loading && !users.data) return <Waiting what="users" shape="table" reload={users.reload} />;
  if (users.error && !users.data) return <LoadFailed what="users" error={users.error} reload={users.reload} />;

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-white p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <h1 className="text-[20px] font-semibold text-[#171717]">Users & roles</h1>
          <p className="text-[13px] text-[#6B6B6B] mt-0.5">Who can sign in, and what each role can do. Tenant: {session.tenant.name}.</p>
        </div>
        <div className="flex rounded border border-[#E5E5E0] bg-white p-0.5 text-[12px]">
          <button onClick={() => setTab('USERS')} className={`px-3 py-1.5 rounded font-medium transition-colors ${tab === 'USERS' ? 'bg-[#171717] text-white' : 'text-[#525252] hover:text-[#171717]'}`}>Users ({users.data?.length ?? 0})</button>
          <button onClick={() => setTab('RBAC')} className={`px-3 py-1.5 rounded font-medium transition-colors ${tab === 'RBAC' ? 'bg-[#171717] text-white' : 'text-[#525252] hover:text-[#171717]'}`}>Role permissions</button>
        </div>
      </div>

      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}

      {tab === 'USERS' ? (
        <div className="space-y-4">
          <Card title="User directory" sub="People who can sign in to the web app. Agents get a separate mobile-app login from Workforce › Employees."
            actions={canWrite && <>
              {userCap && (
                <span
                  className={`px-2.5 py-1 rounded text-[12px] font-medium border flex items-center gap-1.5 ${
                    atUserCap
                      ? 'bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]'
                      : userCap.percentage >= 85
                      ? 'bg-[#FFFBEB] border-[#FCD34D] text-[#92400E]'
                      : 'bg-[#FAFAF8] border-[#E5E5E0] text-[#525252]'
                  }`}
                  title={`License allows ${userCap.max} active users. ${userCap.remaining} seats remaining.`}
                >
                  <span className="font-semibold">{userCap.current} / {userCap.max}</span> user accounts
                  {atUserCap ? (
                    <span className="font-bold uppercase text-[10px] tracking-wide text-[#DC2626]">(Limit Reached)</span>
                  ) : (
                    <span className="text-[11px] text-[#737373]">({userCap.remaining} left)</span>
                  )}
                </span>
              )}
              <Btn
                variant={atUserCap ? 'secondary' : 'primary'}
                onClick={() => {
                  if (atUserCap) {
                    setError(`User login capacity reached. Your subscription allows ${userCap.max} active user logins (currently ${userCap.current}). Upgrade your license to add more accounts.`);
                    return;
                  }
                  setShowNew((s) => !s);
                }}
                disabled={busy}
              >
                <Plus className="w-3.5 h-3.5" />New user
              </Btn>
            </>}>
            {showNew && (
              <div className="mb-4 p-3 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                <Field label="Username"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="j.doe" /></Field>
                <Field label="Full name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Jane Doe" /></Field>
                <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="optional" /></Field>
                <Field label="Role"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</Select></Field>
                <Field label="Temporary password" hint="8+ characters. They must choose their own at first sign-in."><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
                <div className="md:col-span-5 flex gap-2"><Btn variant="primary" onClick={createUser} disabled={busy || !form.username || !form.displayName || form.password.length < 8}>Create</Btn><Btn onClick={() => setShowNew(false)}>Cancel</Btn></div>
              </div>
            )}
            {!users.data?.length ? <Empty title="No users yet" /> : (
              <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#FAFAF8] text-[#6B6B6B] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
                    <tr><th className="p-3">User</th><th className="p-3">Role</th><th className="p-3">Access</th><th className="p-3">Status</th><th className="p-3">Last active</th><th className="p-3"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0]">
                    {users.data.map((u) => (
                      <React.Fragment key={u.id}>
                        <tr className="hover:bg-[#FAFAF8]">
                          <td className="p-3"><div className="font-semibold text-[#171717]">{u.userName}{u.id === session.user.id && <span className="text-[11px] text-[#6B6B6B] font-normal"> (you)</span>}</div><div className="text-[11px] text-[#6B6B6B]">{u.username}{u.email ? ` · ${u.email}` : ''}</div></td>
                          <td className="p-3 text-[12px] font-medium">{ROLE_LABEL[u.role] ?? u.role}</td>
                          <td className="p-3 text-[12px]">{u.access ? <span title="Limited to these sites and regions">{u.access}</span> : <span className="text-[#6B6B6B]">Whole organisation</span>}</td>
                          <td className="p-3"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${u.status === 'ACTIVE' ? 'bg-[#EAF5EF] text-[#2A7553]' : 'bg-[#FCEBEC] text-[#BC3F3F]'}`}>{u.status}</span></td>
                          <td className="p-3 text-[12px] text-[#6B6B6B]">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never signed in'}</td>
                          <td className="p-3 text-right">{canWrite && <Btn onClick={() => setEditId(editId === u.id ? null : u.id)}>{editId === u.id ? 'Close' : 'Edit'}</Btn>}</td>
                        </tr>
                        {editId === u.id && editing && (
                          <tr><td colSpan={6} className="p-3 bg-[#FAFAF8] space-y-4">
                            {isSelf && <div className="text-[12px] text-[#6B6B6B] mb-2">You cannot change your own role or status. You can still reset your own password.</div>}
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                              <Field label="Role"><Select value={edit.role} disabled={isSelf} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</Select></Field>
                              <Field label="Status"><Select value={edit.status} disabled={isSelf} onChange={(e) => setEdit({ ...edit, status: e.target.value as WUser['status'] })}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></Select></Field>
                              <Field label="Reset password" hint="leave blank to keep it. A new one is temporary: they choose their own at next sign-in (not if it is yours)."><Input type="text" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
                              <Btn variant="primary" onClick={saveEdit} disabled={busy || (!!edit.password && edit.password.length < 8)}>Save</Btn>
                            </div>
                            <div className="border-t border-[#E5E5E0] pt-3 space-y-2" role="group" aria-label="Access">
                              <div className="text-[13px] font-semibold text-[#171717]">Access</div>
                              <p className="text-[12px] text-[#6B6B6B] max-w-3xl">Limit this person to some regions or sites. They then see only the WFM groups at those sites, and the people, schedules and forecasts that belong to them. They cannot change sites, users, or rules for the whole organisation.</p>
                              {isSelf ? <p className="text-[12px] text-[#6B6B6B]">You cannot change your own access. Ask another administrator.</p> : (
                                <>
                                  <label className="flex items-center gap-2 text-[13px]"><input type="radio" name="acc" checked={!only} onChange={() => setOnly(false)} />The whole organisation</label>
                                  <label className="flex items-center gap-2 text-[13px]"><input type="radio" name="acc" checked={only} onChange={() => setOnly(true)} />Only these regions and sites</label>
                                  {only && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl pl-6">
                                      <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-1">Regions (every site in them)</div>
                                        {(orgRegions.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No regions yet.</p> : (orgRegions.data ?? []).map((r) => (
                                          <label key={r.id} className="flex items-center gap-2 text-[13px] py-0.5"><input type="checkbox" checked={pickRegions.includes(r.id)} onChange={(e) => setPickRegions(e.target.checked ? [...pickRegions, r.id] : pickRegions.filter((x) => x !== r.id))} />{r.name}</label>
                                        ))}
                                      </div>
                                      <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B6B6B] mb-1">Individual sites</div>
                                        {(orgSites.data ?? []).length === 0 ? <p className="text-[12px] text-[#6B6B6B]">No sites yet.</p> : (orgSites.data ?? []).map((st) => (
                                          <label key={st.id} className="flex items-center gap-2 text-[13px] py-0.5"><input type="checkbox" checked={pickSites.includes(st.id)} onChange={(e) => setPickSites(e.target.checked ? [...pickSites, st.id] : pickSites.filter((x) => x !== st.id))} />{st.name}{st.regionName ? <span className="text-[11px] text-[#6B6B6B]">{st.regionName}</span> : null}{st.status === 'CLOSED' ? <span className="text-[11px] text-[#6B6B6B]">closed</span> : null}</label>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {noneChosen && <p className="text-[12px] text-[#8F6200] pl-6">Choose at least one region or site, or pick "The whole organisation".</p>}
                                  <Btn variant="primary" onClick={saveAccess} disabled={busy || noneChosen || !accessChanged}>Save access</Btn>
                                </>
                              )}
                            </div>
                          </td></tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card title="Role permissions" sub="What each role can do, by tenant. WFM_ADMIN always keeps view and manage users, otherwise nobody could fix an accidental lockout.">
          {rbac.loading && !rbac.data ? <Waiting what="permissions" shape="table" reload={rbac.reload} /> : !work ? null : (
            <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-[#FAFAF8] text-[#6B6B6B] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
                  <tr><th className="p-3 w-64">Permission</th>{roles.map((r) => <th key={r} className="p-3 text-center">{ROLE_LABEL[r] ?? r}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[#E5E5E0]">
                  {grouped.map(([cat, perms]) => (
                    <React.Fragment key={cat}>
                      <tr><td colSpan={roles.length + 1} className="px-3 pt-3 pb-1 text-[11px] font-semibold text-[#525252] bg-white">{CATEGORY_LABEL[cat] ?? cat}</td></tr>
                      {perms.map((perm) => (
                        <tr key={perm} className="hover:bg-[#FAFAF8]">
                          <td className="p-3">{prettify(perm)}</td>
                          {roles.map((r) => {
                            const locked = r === 'WFM_ADMIN' && (perm === 'users:read' || perm === 'users:write');
                            const on = work[r]?.has(perm) ?? false;
                            return (
                              <td key={r} className="p-2 text-center">
                                <button disabled={!canWrite || locked} onClick={() => toggle(r, perm)} title={locked ? 'Admin must keep this' : undefined}
                                  className={`inline-flex items-center justify-center w-6 h-6 rounded border ${on ? 'bg-[#171717] border-[#171717] text-white' : 'bg-white border-[#E5E5E0] text-transparent'} ${!canWrite || locked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                                  {on ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && work && (
            <div className="flex flex-wrap gap-2 mt-4">
              {roles.filter((r) => dirty(r)).map((r) => (
                <Pill key={r} tone="warn">
                  {ROLE_LABEL[r] ?? r} changed{' '}
                  <button className="underline ml-1" onClick={() => saveRole(r)} disabled={busy}>save</button>{' · '}
                  <button className="underline" onClick={() => resetRole(r)} disabled={busy}>undo</button>
                </Pill>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
