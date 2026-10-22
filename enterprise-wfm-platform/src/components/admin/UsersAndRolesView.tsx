/**
 * Administration > Users and Roles. Real accounts from the `users` table and the role -> permission matrix from
 * `role_permissions` (seeded from DEFAULT_PERMISSIONS, editable per tenant). WFM_ADMIN always keeps users:read and
 * users:write, and nobody can change their own role or disable their own account — the gateway enforces both.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { api } from '../../services/api';
import { useForecast } from '../../services/forecastStore';
import { useApi } from '../forecasting/hooks';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select } from '../forecasting/ui';

type WUser = { id: string; username: string; userName: string; email: string | null; role: string; status: 'ACTIVE' | 'DISABLED'; employeeId: string | null; createdAt: string; lastLoginAt: string | null };
type Matrix = { roles: string[]; permissions: string[]; matrix: Record<string, string[]>; defaults: Record<string, string[]> };

const ROLE_LABEL: Record<string, string> = { WFM_ADMIN: 'Admin', WFM_MANAGER: 'Manager', FORECAST_PLANNER: 'Planner', SCHEDULER: 'Scheduler', SUPERVISOR_RTA: 'Supervisor', ANALYST: 'Analyst', AGENT: 'Agent' };
const PERM_LABEL: Record<string, string> = {
  'config:read': 'View configuration', 'config:write': 'Change configuration',
  'data:read': 'View imported data', 'data:import': 'Import interval history', 'data:rollback': 'Roll back an import',
  'forecast:read': 'View forecasts', 'forecast:create': 'Create forecasts', 'forecast:adjust': 'Adjust and apply scenarios',
  'forecast:submit': 'Submit for approval', 'forecast:approve': 'Approve forecasts', 'forecast:publish': 'Publish forecasts', 'forecast:delete': 'Delete forecasts',
  'workforce:read': 'View employees and teams', 'workforce:write': 'Edit employees and teams',
  'schedule:read': 'View schedules', 'schedule:generate': 'Generate a schedule', 'schedule:edit': 'Manually edit a schedule', 'schedule:approve': 'Approve a schedule', 'schedule:publish': 'Publish a schedule',
  'intraday:read': 'View intraday and RTA', 'intraday:act': 'Act on intraday recommendations',
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
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

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

  if (users.loading && !users.data) return <Busy text="Loading users…" />;

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-white p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <h1 className="text-[20px] font-semibold text-[#171717]">Users & roles</h1>
          <p className="text-[13px] text-[#737373] mt-0.5">Who can sign in, and what each role can do. Tenant: {session.tenant.name}.</p>
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
            actions={canWrite && <Btn variant="primary" onClick={() => setShowNew((s) => !s)} disabled={busy}><Plus className="w-3.5 h-3.5" />New user</Btn>}>
            {showNew && (
              <div className="mb-4 p-3 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                <Field label="Username"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="j.doe" /></Field>
                <Field label="Full name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Jane Doe" /></Field>
                <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="optional" /></Field>
                <Field label="Role"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</Select></Field>
                <Field label="Temporary password" hint="8+ characters"><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
                <div className="md:col-span-5 flex gap-2"><Btn variant="primary" onClick={createUser} disabled={busy || !form.username || !form.displayName || form.password.length < 8}>Create</Btn><Btn onClick={() => setShowNew(false)}>Cancel</Btn></div>
              </div>
            )}
            {!users.data?.length ? <Empty title="No users yet" /> : (
              <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
                    <tr><th className="p-3">User</th><th className="p-3">Role</th><th className="p-3">Status</th><th className="p-3">Last active</th><th className="p-3"></th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0]">
                    {users.data.map((u) => (
                      <React.Fragment key={u.id}>
                        <tr className="hover:bg-[#FAFAF8]">
                          <td className="p-3"><div className="font-semibold text-[#171717]">{u.userName}{u.id === session.user.id && <span className="text-[11px] text-[#737373] font-normal"> (you)</span>}</div><div className="text-[11px] text-[#737373]">{u.username}{u.email ? ` · ${u.email}` : ''}</div></td>
                          <td className="p-3 text-[12px] font-medium">{ROLE_LABEL[u.role] ?? u.role}</td>
                          <td className="p-3"><span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${u.status === 'ACTIVE' ? 'bg-[#EAF5EF] text-[#2F7D5A]' : 'bg-[#FCEBEC] text-[#C84A4A]'}`}>{u.status}</span></td>
                          <td className="p-3 text-[12px] text-[#737373]">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never signed in'}</td>
                          <td className="p-3 text-right">{canWrite && <Btn onClick={() => setEditId(editId === u.id ? null : u.id)}>{editId === u.id ? 'Close' : 'Edit'}</Btn>}</td>
                        </tr>
                        {editId === u.id && editing && (
                          <tr><td colSpan={5} className="p-3 bg-[#FAFAF8]">
                            {isSelf && <div className="text-[12px] text-[#737373] mb-2">You cannot change your own role or status. You can still reset your own password.</div>}
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                              <Field label="Role"><Select value={edit.role} disabled={isSelf} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</Select></Field>
                              <Field label="Status"><Select value={edit.status} disabled={isSelf} onChange={(e) => setEdit({ ...edit, status: e.target.value as WUser['status'] })}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></Select></Field>
                              <Field label="Reset password" hint="leave blank to keep it"><Input type="text" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
                              <Btn variant="primary" onClick={saveEdit} disabled={busy || (!!edit.password && edit.password.length < 8)}>Save</Btn>
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
          {rbac.loading && !rbac.data ? <Busy text="Loading permissions…" /> : !work ? null : (
            <div className="overflow-x-auto border border-[#E5E5E0] rounded-lg">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-[#FAFAF8] text-[#737373] text-[11px] uppercase tracking-wider border-b border-[#E5E5E0]">
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
