/**
 * Administration > Workspaces & Organisation.
 * Provides complete multi-organisation management and multiple workspace creation with
 * strict workspace-level data isolation.
 */
import React, { useEffect, useState } from 'react';
import {
  Building2, Plus, Users, Globe, Check, AlertCircle, ArrowRight,
  Shield, Archive, Edit2, Key, RefreshCw
} from 'lucide-react';
import {
  Session, Workspace, WorkspaceMember, OrganizationProfile,
  fetchWorkspaces, createWorkspace, updateWorkspace, archiveWorkspace,
  fetchWorkspaceMembers, addWorkspaceMember, updateWorkspaceMember, removeWorkspaceMember,
  fetchOrganization,
  switchWorkspace, refreshSession, api
} from '../../services/api';
import { Banner, Btn, Busy, Card, Empty, Field, Input, Kpi, KpiRow, Pill, Select, Table } from '../forecasting/ui';

const ROLES = ['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT'] as const;
const ROLE_LABEL: Record<string, string> = {
  WFM_ADMIN: 'Administrator',
  WFM_MANAGER: 'Manager',
  FORECAST_PLANNER: 'Forecast Planner',
  SCHEDULER: 'Scheduler',
  SUPERVISOR_RTA: 'Supervisor / RTA',
  ANALYST: 'Analyst',
  AGENT: 'Agent',
};

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'JPY'];

interface WorkspacesViewProps {
  session: Session;
  onSwitchWorkspace?: (newSession: Session) => void;
}

export const WorkspacesView: React.FC<WorkspacesViewProps> = ({ session, onSwitchWorkspace }) => {
  const [tab, setTab] = useState<'WORKSPACES' | 'ORG'>('WORKSPACES');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [orgProfile, setOrgProfile] = useState<OrganizationProfile | null>(null);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  // Workspace Modals
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [newWs, setNewWs] = useState({
    name: '',
    code: '',
    slug: '',
    description: '',
    timezone: session.tenant.timezone || 'UTC',
    currency: session.tenant.currency || 'USD',
  });

  const [editWs, setEditWs] = useState<Workspace | null>(null);
  const [editWsForm, setEditWsForm] = useState({
    name: '',
    code: '',
    slug: '',
    description: '',
    timezone: 'UTC',
    currency: 'USD',
  });

  // Members Modal
  const [activeMembersWs, setActiveMembersWs] = useState<Workspace | null>(null);
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [memberForm, setMemberForm] = useState({ userId: '', role: 'SCHEDULER' });

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [wsList, org, users] = await Promise.all([
        fetchWorkspaces().catch(() => []),
        fetchOrganization().catch(() => null),
        api<any[]>('/users').catch(() => []),
      ]);
      setWorkspaces(wsList);
      setOrgProfile(org);
      setAllUsers(users);
    } catch (e: any) {
      setError(e.message || 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [session.workspace?.id]);

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWs.name || !newWs.code) return;
    setBusy(true);
    setError('');
    try {
      const created = await createWorkspace({
        ...newWs,
        code: newWs.code.trim().toUpperCase(),
        slug: newWs.slug.trim().toLowerCase() || newWs.code.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      });
      setShowCreateWs(false);
      setNewWs({
        name: '',
        code: '',
        slug: '',
        description: '',
        timezone: session.tenant.timezone || 'UTC',
        currency: session.tenant.currency || 'USD',
      });
      setNotice(`Workspace "${created.name}" created successfully.`);
      const updatedSession = await refreshSession().catch(() => null);
      if (updatedSession && onSwitchWorkspace) {
        onSwitchWorkspace(updatedSession);
      }
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  };

  const handleEditWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editWs) return;
    setBusy(true);
    setError('');
    try {
      await updateWorkspace(editWs.id, editWsForm);
      setEditWs(null);
      setNotice(`Workspace updated.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to update workspace');
    } finally {
      setBusy(false);
    }
  };

  const handleArchiveWorkspace = async (ws: Workspace) => {
    if (!confirm(`Are you sure you want to archive workspace "${ws.name}"? Users will no longer be able to select it.`)) return;
    setBusy(true);
    setError('');
    try {
      await archiveWorkspace(ws.id);
      setNotice(`Workspace "${ws.name}" archived.`);
      const updatedSession = await refreshSession().catch(() => null);
      if (updatedSession && onSwitchWorkspace) {
        onSwitchWorkspace(updatedSession);
      }
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to archive workspace');
    } finally {
      setBusy(false);
    }
  };

  const openMembersModal = async (ws: Workspace) => {
    setActiveMembersWs(ws);
    setMemberForm({ userId: allUsers[0]?.id || '', role: 'SCHEDULER' });
    try {
      const members = await fetchWorkspaceMembers(ws.id);
      setWsMembers(members);
    } catch (err: any) {
      setError(err.message || 'Failed to load workspace members');
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMembersWs || !memberForm.userId) return;
    setBusy(true);
    try {
      await addWorkspaceMember(activeMembersWs.id, {
        userId: memberForm.userId,
        role: memberForm.role,
      });
      const updated = await fetchWorkspaceMembers(activeMembersWs.id);
      setWsMembers(updated);
      setNotice('Member added to workspace.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to add member');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateMemberRole = async (userId: string, newRole: string) => {
    if (!activeMembersWs) return;
    try {
      await updateWorkspaceMember(activeMembersWs.id, userId, { role: newRole });
      const updated = await fetchWorkspaceMembers(activeMembersWs.id);
      setWsMembers(updated);
      setNotice('Member role updated.');
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!activeMembersWs) return;
    if (!confirm('Remove user from this workspace?')) return;
    try {
      await removeWorkspaceMember(activeMembersWs.id, userId);
      const updated = await fetchWorkspaceMembers(activeMembersWs.id);
      setWsMembers(updated);
      setNotice('Member removed.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to remove member');
    }
  };

  const handleSwitchWorkspace = async (wsId: string) => {
    try {
      setError('');
      const updatedSession = await switchWorkspace(wsId);
      if (onSwitchWorkspace) {
        onSwitchWorkspace(updatedSession);
      }
      setNotice('Switched to workspace successfully.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to switch workspace');
    }
  };

  const filteredWorkspaces = workspaces.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) ||
      w.code.toLowerCase().includes(search.toLowerCase()) ||
      w.timezone.toLowerCase().includes(search.toLowerCase())
  );

  const activeCount = workspaces.filter((w) => w.status === 'ACTIVE').length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-bold text-[#171717] tracking-tight">Workspaces & Organisation</h1>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20">
              Multi-Tenant & Isolated
            </span>
          </div>
          <p className="text-[13px] text-[#737373] mt-1">
            Manage operational workspaces and settings for <strong className="text-[#171717]">{session.tenant.name}</strong>.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center border border-[#E5E5E0] rounded bg-[#FAFAF8] p-0.5 text-[12px] font-medium">
          <button
            onClick={() => setTab('WORKSPACES')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
              tab === 'WORKSPACES' ? 'bg-[#171717] text-white shadow-xs' : 'text-[#525252] hover:text-[#171717]'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Workspaces ({workspaces.length})</span>
          </button>
          <button
            onClick={() => setTab('ORG')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
              tab === 'ORG' ? 'bg-[#171717] text-white shadow-xs' : 'text-[#525252] hover:text-[#171717]'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Organisation Profile</span>
          </button>
        </div>
      </div>

      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      {error && <Banner kind="err" onClose={() => setError('')}>{error}</Banner>}

      {loading ? (
        <div className="py-12 flex justify-center"><Busy text="Loading configuration..." /></div>
      ) : tab === 'WORKSPACES' ? (
        <div className="space-y-6">
          {/* KPI Summary */}
          <KpiRow>
            <Kpi label="Total Workspaces" value={workspaces.length} />
            <Kpi label="Active Workspaces" value={activeCount} tone="good" />
            <Kpi
              label="Current Workspace"
              value={session.workspace?.name || 'Default'}
              sub={session.workspace?.code ? `Code: ${session.workspace.code}` : undefined}
            />
            <Kpi label="Data Isolation" value="100% Strict" sub="Enforced by RLS & workspace_id" tone="good" />
          </KpiRow>

          {/* Action & Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="w-72">
              <Input
                placeholder="Search workspaces by name or code..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Btn onClick={loadData} title="Refresh list">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Btn>
              <Btn variant="primary" onClick={() => setShowCreateWs(true)}>
                <Plus className="w-3.5 h-3.5" /> Create Workspace
              </Btn>
            </div>
          </div>

          {/* Workspaces Table */}
          <Card title="Operational Workspaces" sub="Each workspace provides independent queues, shifts, employees, schedules, and forecasts that never leak across workspace boundaries.">
            {filteredWorkspaces.length === 0 ? (
              <Empty title="No workspaces found">
                Create your first additional workspace using the button above.
              </Empty>
            ) : (
              <Table head={['Workspace', 'Code & Slug', 'Status', 'Timezone & Currency', 'Members', 'Actions']}>
                {filteredWorkspaces.map((ws) => {
                  const isCurrent = ws.id === session.workspace?.id;
                  return (
                    <tr key={ws.id} className={isCurrent ? 'bg-[#FAFAF8]' : ''}>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Building2 className={`w-4 h-4 ${isCurrent ? 'text-[#2F7D5A]' : 'text-[#737373]'}`} />
                          <div>
                            <div className="font-semibold text-[#171717] flex items-center gap-1.5">
                              {ws.name}
                              {ws.isDefault && <Pill tone="info">Default</Pill>}
                              {isCurrent && <Pill tone="good">Active Now</Pill>}
                            </div>
                            {ws.description && <p className="text-[11px] text-[#737373] line-clamp-1">{ws.description}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="font-mono text-[12px] font-semibold text-[#171717]">{ws.code}</div>
                        <div className="text-[11px] text-[#737373]">/{ws.slug}</div>
                      </td>
                      <td className="p-3">
                        <Pill tone={ws.status === 'ACTIVE' ? 'good' : 'neutral'}>
                          {ws.status}
                        </Pill>
                      </td>
                      <td className="p-3">
                        <div className="text-[12px] text-[#171717]">{ws.timezone}</div>
                        <div className="text-[11px] text-[#737373]">{ws.currency}</div>
                      </td>
                      <td className="p-3">
                        <button
                          onClick={() => openMembersModal(ws)}
                          className="flex items-center gap-1.5 text-[12px] font-semibold text-[#2F7D5A] hover:underline"
                        >
                          <Users className="w-3.5 h-3.5" />
                          <span>{ws.memberCount} member{ws.memberCount !== 1 ? 's' : ''}</span>
                        </button>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {!isCurrent && ws.status === 'ACTIVE' && (
                            <Btn variant="secondary" onClick={() => handleSwitchWorkspace(ws.id)}>
                              <ArrowRight className="w-3 h-3 text-[#2F7D5A]" /> Switch
                            </Btn>
                          )}
                          <Btn
                            onClick={() => {
                              setEditWs(ws);
                              setEditWsForm({
                                name: ws.name,
                                code: ws.code,
                                slug: ws.slug,
                                description: ws.description || '',
                                timezone: ws.timezone,
                                currency: ws.currency,
                              });
                            }}
                            title="Edit settings"
                          >
                            <Edit2 className="w-3 h-3" /> Edit
                          </Btn>
                          {!ws.isDefault && !isCurrent && ws.status === 'ACTIVE' && (
                            <Btn
                              onClick={() => handleArchiveWorkspace(ws)}
                              className="text-[#C84A4A] hover:bg-[#FCEBEC]"
                              title="Archive workspace"
                            >
                              <Archive className="w-3 h-3" /> Archive
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>
      ) : (
        /* Organisation & Multi-Tenancy Provisioning Tab (Read-Only) */
        <div className="space-y-6">
          {/* Current Organisation Settings */}
          <Card
            title={`Organisation Profile: ${orgProfile?.displayName || session.tenant.name}`}
            actions={<Pill tone="neutral">Read-Only</Pill>}
            sub="Global settings and enterprise identity. This is the top-level boundary enclosing all of your workspaces."
          >
            <div className="space-y-4 max-w-2xl">
              <Banner kind="info">
                Organisation details and root configuration are centrally managed by the Platform Super Administrator and cannot be edited from the workspace administration view.
              </Banner>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Display Name" hint="Organisation name shown in header navigation">
                  <Input
                    value={orgProfile?.displayName || orgProfile?.name || session.tenant.name}
                    disabled
                    readOnly
                  />
                </Field>
                <Field label="Legal Organisation Name" hint="Registered enterprise legal entity">
                  <Input
                    value={orgProfile?.legalName || orgProfile?.name || session.tenant.name}
                    disabled
                    readOnly
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Organisation Code (Immutable)" hint="Tenant isolation key">
                  <Input value={session.tenant.code} disabled readOnly />
                </Field>
                <Field label="Default Timezone" hint="Tenant baseline operational timezone">
                  <Input
                    value={orgProfile?.timezone || session.tenant.timezone || 'UTC'}
                    disabled
                    readOnly
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Default Currency" hint="Operating currency">
                  <Input
                    value={orgProfile?.currency || session.tenant.currency || 'USD'}
                    disabled
                    readOnly
                  />
                </Field>
                <Field label="Locale" hint="Regional locale">
                  <Input
                    value={orgProfile?.locale || 'en'}
                    disabled
                    readOnly
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Contact Person" hint="Organisation primary contact">
                  <Input
                    value={orgProfile?.contactName || '—'}
                    disabled
                    readOnly
                  />
                </Field>
                <Field label="Contact Email" hint="Organisation contact email">
                  <Input
                    type="email"
                    value={orgProfile?.contactEmail || '—'}
                    disabled
                    readOnly
                  />
                </Field>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Modal: Create Workspace */}
      {showCreateWs && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-lg border border-[#E5E5E0] shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#2F7D5A]" /> Create New Workspace
              </h3>
              <button onClick={() => setShowCreateWs(false)} className="text-[#737373] hover:text-[#171717]">✕</button>
            </div>

            <form onSubmit={handleCreateWorkspace} className="space-y-3">
              <Field label="Workspace Name">
                <Input
                  placeholder="e.g. EMEA Customer Care"
                  value={newWs.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    const code = name.replace(/[^A-Za-z0-9]/g, '_').slice(0, 16).toUpperCase();
                    setNewWs((prev) => ({
                      ...prev,
                      name,
                      code: prev.code ? prev.code : code,
                      slug: name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
                    }));
                  }}
                  required
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Code (e.g. EMEA_CC)">
                  <Input
                    value={newWs.code}
                    onChange={(e) => setNewWs({ ...newWs, code: e.target.value.toUpperCase() })}
                    required
                  />
                </Field>
                <Field label="URL Slug">
                  <Input
                    value={newWs.slug}
                    onChange={(e) => setNewWs({ ...newWs, slug: e.target.value.toLowerCase() })}
                    required
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Timezone">
                  <Select
                    value={newWs.timezone}
                    onChange={(e) => setNewWs({ ...newWs, timezone: e.target.value })}
                  >
                    {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </Select>
                </Field>
                <Field label="Currency">
                  <Select
                    value={newWs.currency}
                    onChange={(e) => setNewWs({ ...newWs, currency: e.target.value })}
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
              </div>

              <Field label="Description (Optional)">
                <Input
                  placeholder="Operational purpose, department, or location..."
                  value={newWs.description}
                  onChange={(e) => setNewWs({ ...newWs, description: e.target.value })}
                />
              </Field>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                <Btn type="button" onClick={() => setShowCreateWs(false)}>Cancel</Btn>
                <Btn variant="primary" type="submit" disabled={busy || !newWs.name || !newWs.code}>
                  {busy ? <Busy text="Creating..." /> : 'Create Workspace'}
                </Btn>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Edit Workspace */}
      {editWs && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-lg border border-[#E5E5E0] shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <h3 className="text-[16px] font-bold text-[#171717]">Edit Workspace: {editWs.name}</h3>
              <button onClick={() => setEditWs(null)} className="text-[#737373] hover:text-[#171717]">✕</button>
            </div>

            <form onSubmit={handleEditWorkspace} className="space-y-3">
              <Field label="Workspace Name">
                <Input
                  value={editWsForm.name}
                  onChange={(e) => setEditWsForm({ ...editWsForm, name: e.target.value })}
                  required
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Timezone">
                  <Select
                    value={editWsForm.timezone}
                    onChange={(e) => setEditWsForm({ ...editWsForm, timezone: e.target.value })}
                  >
                    {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </Select>
                </Field>
                <Field label="Currency">
                  <Select
                    value={editWsForm.currency}
                    onChange={(e) => setEditWsForm({ ...editWsForm, currency: e.target.value })}
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
              </div>

              <Field label="Description">
                <Input
                  value={editWsForm.description}
                  onChange={(e) => setEditWsForm({ ...editWsForm, description: e.target.value })}
                />
              </Field>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                <Btn type="button" onClick={() => setEditWs(null)}>Cancel</Btn>
                <Btn variant="primary" type="submit" disabled={busy}>
                  {busy ? <Busy text="Saving..." /> : 'Save Changes'}
                </Btn>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Manage Workspace Members */}
      {activeMembersWs && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-lg border border-[#E5E5E0] shadow-2xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                  <Users className="w-4 h-4 text-[#2F7D5A]" /> Workspace Members: {activeMembersWs.name}
                </h3>
                <p className="text-[12px] text-[#737373]">
                  Users assigned to this workspace can access and edit its data according to their role.
                </p>
              </div>
              <button onClick={() => setActiveMembersWs(null)} className="text-[#737373] hover:text-[#171717]">✕</button>
            </div>

            {/* Add Member Form */}
            <form onSubmit={handleAddMember} className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold text-[#737373] uppercase mb-1">Select User</label>
                <Select
                  value={memberForm.userId}
                  onChange={(e) => setMemberForm({ ...memberForm, userId: e.target.value })}
                  required
                >
                  <option value="">-- Choose User --</option>
                  {allUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.userName || u.username} ({u.username})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-48">
                <label className="block text-[11px] font-semibold text-[#737373] uppercase mb-1">Role in Workspace</label>
                <Select
                  value={memberForm.role}
                  onChange={(e) => setMemberForm({ ...memberForm, role: e.target.value })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </Select>
              </div>
              <Btn variant="primary" type="submit" disabled={busy || !memberForm.userId}>
                <Plus className="w-3.5 h-3.5" /> Assign
              </Btn>
            </form>

            {/* Members Table */}
            <div className="max-h-80 overflow-y-auto">
              <Table head={['User', 'Workspace Role', 'Status', 'Actions']}>
                {wsMembers.map((m) => (
                  <tr key={m.userId}>
                    <td className="p-3">
                      <div className="font-semibold text-[#171717]">{m.userName || m.username}</div>
                      <div className="text-[11px] text-[#737373]">{m.email || m.username}</div>
                    </td>
                    <td className="p-3">
                      <Select
                        value={m.role}
                        onChange={(e) => handleUpdateMemberRole(m.userId, e.target.value)}
                        className="py-1 text-[12px]"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="p-3">
                      <Pill tone={m.status === 'ACTIVE' ? 'good' : 'neutral'}>{m.status}</Pill>
                    </td>
                    <td className="p-3">
                      {m.userId !== session.user.id && (
                        <Btn
                          onClick={() => handleRemoveMember(m.userId)}
                          className="text-[#C84A4A] hover:bg-[#FCEBEC]"
                          title="Remove from workspace"
                        >
                          Remove
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>

            <div className="flex justify-end pt-2">
              <Btn onClick={() => setActiveMembersWs(null)}>Done</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
