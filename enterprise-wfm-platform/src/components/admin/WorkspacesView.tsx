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
import { Banner, Btn, Busy, Card, Empty, Field, Input, Pill, Select, Table } from '../forecasting/ui';
import { Grid } from '../forecasting/Grid';
import { CreateWorkspaceDialog, EditWorkspaceDialog } from './WorkspaceDialogs';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';

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
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'ARCHIVED'>('ALL');

  // Workspace Modals
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [editWs, setEditWs] = useState<Workspace | null>(null);
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
      (statusFilter === 'ALL' || w.status === statusFilter) &&
      (w.name.toLowerCase().includes(search.toLowerCase()) ||
        w.code.toLowerCase().includes(search.toLowerCase()) ||
        w.timezone.toLowerCase().includes(search.toLowerCase()))
  );

  const activeCount = workspaces.filter((w) => w.status === 'ACTIVE').length;
  const totalMembers = workspaces.reduce((n, w) => n + (w.memberCount || 0), 0);

  const startEdit = (ws: Workspace) => setEditWs(ws);

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Name', 'Code', 'Slug', 'Status', 'Timezone', 'Currency', 'Members', 'Default', 'Created'],
      ...filteredWorkspaces.map((w) => [w.name, w.code, w.slug, w.status, w.timezone, w.currency, w.memberCount, w.isDefault ? 'Yes' : 'No', w.createdAt || '']),
    ];
    const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'workspaces.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const columns: ColDef<Workspace>[] = [
    {
      headerName: 'Workspace', field: 'name', flex: 2, minWidth: 240,
      cellRenderer: (p: ICellRendererParams<Workspace>) => {
        const ws = p.data!;
        const isCurrent = ws.id === session.workspace?.id;
        return (
          <div className="flex items-center gap-2.5 h-full">
            <Building2 className={`w-4 h-4 shrink-0 ${isCurrent ? 'text-[#2F7D5A]' : 'text-[#737373]'}`} />
            <div className="min-w-0 leading-tight">
              <div className="font-semibold text-[#171717] flex items-center gap-1.5">
                <span className="truncate">{ws.name}</span>
                {ws.isDefault && <Pill tone="info">Default</Pill>}
                {isCurrent && <Pill tone="good">Current</Pill>}
              </div>
              {ws.description && <div className="text-[11px] text-[#737373] truncate">{ws.description}</div>}
            </div>
          </div>
        );
      },
    },
    {
      headerName: 'Code', field: 'code', width: 150,
      cellRenderer: (p: ICellRendererParams<Workspace>) => (
        <div className="leading-tight flex flex-col justify-center h-full">
          <span className="font-mono text-[12px] font-semibold text-[#171717]">{p.data!.code}</span>
          <span className="text-[11px] text-[#737373]">/{p.data!.slug}</span>
        </div>
      ),
    },
    {
      headerName: 'Status', field: 'status', width: 120,
      cellRenderer: (p: ICellRendererParams<Workspace>) => (
        <div className="flex items-center h-full">
          <Pill tone={p.data!.status === 'ACTIVE' ? 'good' : 'neutral'}>{p.data!.status === 'ACTIVE' ? 'Active' : 'Archived'}</Pill>
        </div>
      ),
    },
    { headerName: 'Timezone', field: 'timezone', width: 160 },
    { headerName: 'Currency', field: 'currency', width: 110 },
    {
      headerName: 'Members', field: 'memberCount', width: 130, type: 'numericColumn',
      cellRenderer: (p: ICellRendererParams<Workspace>) => (
        <button onClick={() => openMembersModal(p.data!)} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#2F7D5A] hover:underline">
          <Users className="w-3.5 h-3.5" /> {p.data!.memberCount}
        </button>
      ),
    },
    {
      headerName: 'Created', field: 'createdAt', width: 130,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleDateString() : '—'),
    },
    {
      headerName: 'Actions', colId: 'actions', width: 250, pinned: 'right', sortable: false, filter: false,
      cellRenderer: (p: ICellRendererParams<Workspace>) => {
        const ws = p.data!;
        const isCurrent = ws.id === session.workspace?.id;
        return (
          <div className="flex items-center gap-2 h-full">
            {!isCurrent && ws.status === 'ACTIVE' && (
              <Btn variant="secondary" onClick={() => handleSwitchWorkspace(ws.id)}>
                <ArrowRight className="w-3 h-3 text-[#2F7D5A]" /> Switch
              </Btn>
            )}
            <Btn onClick={() => startEdit(ws)} title="Edit settings"><Edit2 className="w-3 h-3" /> Edit</Btn>
            {!ws.isDefault && !isCurrent && ws.status === 'ACTIVE' && (
              <Btn onClick={() => handleArchiveWorkspace(ws)} className="text-[#C84A4A] hover:bg-[#FCEBEC]" title="Archive workspace">
                <Archive className="w-3 h-3" /> Archive
              </Btn>
            )}
          </div>
        );
      },
    },
  ];
  const gridHeight = Math.min(filteredWorkspaces.length, 10) * 56 + 48 + (filteredWorkspaces.length > 10 ? 48 : 2);

  return (
    <div className="p-6 w-full max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-bold text-[#171717] tracking-tight">Workspaces & Organisation</h1>
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
          {/* Compact summary */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] px-4 py-2.5 text-[13px] text-[#525252]">
            <span><strong className="tabular-nums text-[#171717]">{workspaces.length}</strong> workspace{workspaces.length !== 1 ? 's' : ''} ({activeCount} active)</span>
            <span><strong className="tabular-nums text-[#171717]">{totalMembers}</strong> member assignments</span>
            <span>Current: <strong className="text-[#171717]">{session.workspace?.name || 'Default'}</strong>{session.workspace?.code ? ` (${session.workspace.code})` : ''}</span>
            <span className="inline-flex items-center gap-1.5 text-[#2A7553]" title="Queues, people, schedules and forecasts in one workspace are never visible from another.">
              <Shield className="w-3.5 h-3.5" /> Data is kept separate for each workspace
            </span>
          </div>

          {/* Action & Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="w-72">
                <Input
                  placeholder="Search by name, code or timezone"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search workspaces"
                />
              </div>
              <div className="w-36">
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ACTIVE' | 'ARCHIVED')} aria-label="Filter by status">
                  <option value="ALL">All statuses</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ARCHIVED">Archived</option>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Btn onClick={exportCsv} title="Download the listed workspaces as CSV" disabled={filteredWorkspaces.length === 0}>
                Export CSV
              </Btn>
              <Btn onClick={loadData} title="Refresh list">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </Btn>
              <Btn variant="primary" onClick={() => setShowCreateWs(true)}>
                <Plus className="w-3.5 h-3.5" /> Create Workspace
              </Btn>
            </div>
          </div>

          {/* Workspaces Table */}
          {filteredWorkspaces.length === 0 ? (
            <Empty title={workspaces.length === 0 ? 'No workspaces yet' : 'No workspaces match your filters'}>
              {workspaces.length === 0 ? 'Create your first workspace using the button above.' : 'Clear the search or status filter to see all workspaces.'}
            </Empty>
          ) : (
            <Grid<Workspace>
              height={gridHeight}
              rowData={filteredWorkspaces}
              columnDefs={columns}
              defaultColDef={{ sortable: true, resizable: true, cellStyle: { display: 'flex', alignItems: 'center', lineHeight: '1.4' } }}
              rowHeight={56}
              getRowId={(p) => p.data.id}
              pagination={filteredWorkspaces.length > 10}
              paginationPageSize={10}
              paginationPageSizeSelector={false}
            />
          )}
          <p className="text-[12px] text-[#737373]">Each workspace has its own queues, shifts, people, schedules and forecasts.</p>
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

      {showCreateWs && (
        <CreateWorkspaceDialog session={session} workspaces={workspaces} onClose={() => setShowCreateWs(false)} onCreated={async (created) => {
          setShowCreateWs(false);
          const st = created.setup;
          const bits = st ? [st.copied.length ? `copied ${st.copied.join(', ')}` : '', st.holidaysAdded ? `added ${st.holidaysAdded} public holidays` : '', st.packName ? `applied the ${st.packName} labour-law pack` : ''].filter(Boolean) : [];
          setNotice(`Workspace "${created.name}" created${bits.length ? `: ${bits.join(', ')}` : ''}.${st?.failed ? ` Part of the setup could not be completed (${st.failed}). You can finish it from Configuration.` : ''}`);
          const updatedSession = await refreshSession().catch(() => null);
          if (updatedSession && onSwitchWorkspace) onSwitchWorkspace(updatedSession);
          await loadData();
        }} />
      )}

      {editWs && (
        <EditWorkspaceDialog workspace={editWs} current={editWs.id === session.workspace?.id} onClose={() => setEditWs(null)} onChanged={async (message) => {
          setEditWs(null); setNotice(message);
          const updatedSession = await refreshSession().catch(() => null);
          if (updatedSession && onSwitchWorkspace) onSwitchWorkspace(updatedSession);
          await loadData();
        }} />
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
              <button onClick={() => setActiveMembersWs(null)} className="text-[#737373] hover:text-[#171717]" aria-label="Close">Close</button>
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
