/**
 * Platform Super Administrator Portal.
 * Accessible exclusively at /platform.
 * Uses dedicated platform token authentication (PLATFORM_JWT_SECRET, audience 'platform').
 * Isolated from tenant sessions and tenant RLS.
 * Visual theme matches the Enterprise WFM white theme (#FAFAF8, #FFFFFF, #E5E5E0, #171717, #2F7D5A).
 * Features Interactive Hierarchical Tree View (Platform → Organisations → Workspaces & Admins).
 */
import React, { useEffect, useState } from 'react';
import {
  ShieldAlert, Building2, Plus, Users, Globe, Check, AlertCircle,
  LogOut, RefreshCw, Key, Copy, CheckCircle2, ArrowLeft, Edit2, Settings, ExternalLink,
  FolderTree, List, ChevronDown, ChevronRight, Layers, Server, Shield,
  BarChart3, Activity, TrendingUp, Database, HardDrive, Cpu, Radio, Clock, Sparkles, Filter, Search, ArrowUpRight, BarChart2,
  ShieldCheck, FileText, KeyRound, Lock, Unlock, AlertOctagon, Terminal, ScrollText, UserCheck, UserX
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend
} from 'recharts';

interface PlatformAdmin {
  id: string;
  email: string;
  status: string;
}

interface TenantTelemetry {
  id: string;
  name: string;
  code: string;
  displayName: string;
  legalName: string;
  timezone: string;
  currency: string;
  createdAt: string;
  workspaceCount: number;
  userCount: number;
  activeUserCount: number;
  employeeCount: number;
  scheduleCount: number;
  publishedScheduleCount: number;
  forecastCount: number;
  intervalCount: number;
  shiftTemplateCount: number;
  connectorCount: number;
  auditCount: number;
  lastActiveAt: string;
  activityScore: number;
  statusTier: 'HIGH_ACTIVITY' | 'MODERATE' | 'IDLE';
}

interface StorageDistributionItem {
  name: string;
  records: number;
  category: string;
}

interface RecentAuditItem {
  id: string;
  at: string;
  tenantId: string;
  tenantName: string;
  tenantCode: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityName?: string;
  diffSummary?: string;
  source: string;
}

interface PlatformAnalyticsData {
  platform: {
    totalOrgs: number;
    totalWorkspaces: number;
    totalUsers: number;
    totalActiveUsers: number;
    totalEmployees: number;
    totalSchedules: number;
    totalPublishedSchedules: number;
    totalShifts: number;
    totalForecasts: number;
    totalIntervals: number;
    totalConnectors: number;
    totalAuditLogs: number;
    telemetryUptime: string;
    telemetryStatus: string;
  };
  tenants: TenantTelemetry[];
  storageDistribution: StorageDistributionItem[];
  recentAudit: RecentAuditItem[];
}

interface PlatformAuditItem {
  id: string;
  at: string;
  adminId?: string;
  adminEmail: string;
  action: string;
  targetTenantId?: string;
  targetTenantName?: string;
  targetTenantCode?: string;
  targetEntityType: string;
  targetEntityId?: string;
  targetEntityName?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, any>;
  status: 'SUCCESS' | 'FAILURE' | 'WARNING';
}

interface PlatformAuditStats {
  totalEvents: number;
  sessionEvents: number;
  provisioningEvents: number;
  credentialResets: number;
  securityAlerts: number;
}

interface PlatformAuditResponse {
  total: number;
  limit: number;
  offset: number;
  items: PlatformAuditItem[];
  stats: PlatformAuditStats;
}

interface EmergencyResetLedgerItem {
  id: string;
  tenantId?: string;
  tenant_id?: string;
  userId?: string;
  user_id?: string;
  createdByAdminEmail?: string;
  created_by_admin_email?: string;
  tempPasswordHint?: string;
  temp_password_hint?: string;
  expiresAt?: string;
  expires_at?: string;
  usedAt?: string;
  used_at?: string;
  createdAt?: string;
  created_at?: string;
  username?: string;
  target_username?: string;
  targetUsername?: string;
  displayName?: string;
  display_name?: string;
  email?: string;
  role?: string;
  tenantName?: string;
  tenant_name?: string;
  tenantCode?: string;
  tenant_code?: string;
  tokenStatus?: 'ACTIVE' | 'USED' | 'EXPIRED';
  token_status?: 'ACTIVE' | 'USED' | 'EXPIRED';
}

interface EmergencyResetResult {
  success: boolean;
  user: {
    id: string;
    username: string;
    displayName: string;
    email?: string;
    role: string;
    tenantName: string;
    tenantCode: string;
  };
  method: 'TEMPORARY_PASSWORD' | 'RESET_LINK' | 'BOTH';
  temporaryPassword?: string | null;
  resetToken: string;
  resetUrl: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

interface PlatformOrg {
  id: string;
  name: string;
  code: string;
  legal_name?: string;
  legalName?: string;
  display_name?: string;
  displayName?: string;
  contact_name?: string;
  contactName?: string;
  contact_email?: string;
  contactEmail?: string;
  timezone: string;
  currency: string;
  locale?: string;
  workspace_count?: number;
  workspaceCount?: number;
  user_count?: number;
  userCount?: number;
  created_at?: string;
  createdAt?: string;
}

interface OrgWorkspace {
  id: string;
  name: string;
  code: string;
  slug: string;
  description?: string;
  timezone: string;
  currency: string;
  status: string;
  is_default?: boolean;
  isDefault?: boolean;
  member_count?: number;
  memberCount?: number;
  created_at?: string;
  createdAt?: string;
}

interface TreeWorkspace {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  slug: string;
  description?: string;
  timezone: string;
  currency: string;
  status: string;
  isDefault: boolean;
  memberCount: number;
  createdAt?: string;
}

interface TreeAdmin {
  id: string;
  tenantId: string;
  username: string;
  displayName?: string;
  email?: string;
  role: string;
  status: string;
  createdAt?: string;
}

interface TreeOrg {
  id: string;
  name: string;
  code: string;
  displayName: string;
  display_name?: string;
  legalName: string;
  legal_name?: string;
  contactName?: string;
  contact_name?: string;
  contactEmail?: string;
  contact_email?: string;
  timezone: string;
  currency: string;
  locale?: string;
  createdAt?: string;
  created_at?: string;
  workspaceCount: number;
  adminCount: number;
  workspaces: TreeWorkspace[];
  admins: TreeAdmin[];
}

interface TreeData {
  platform: {
    name: string;
    version: string;
    totalOrgs: number;
    totalWorkspaces: number;
    totalAdmins: number;
  };
  tree: TreeOrg[];
}

const PLATFORM_TOKEN_KEY = 'wfm_platform_token';
const BASE = '/api/v1/platform';

const COMMON_TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'JPY'];

async function platformApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(PLATFORM_TOKEN_KEY);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || (typeof data.error === 'string' ? data.error : null) || data.message || `Request failed with status ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const timeAgo = (iso?: string | null) => {
  if (!iso) return 'Never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#E5E5E0] shadow-md rounded p-2.5 text-xs">
        <div className="font-semibold text-[#171717] mb-1">{label}</div>
        <div className="space-y-0.5">
          {payload.map((entry: any, index: number) => (
            <div key={`item-${index}`} className="flex items-center gap-3 justify-between">
              <span className="flex items-center gap-1.5 text-[#737373]">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                <span>{entry.name}:</span>
              </span>
              <span className="font-mono font-semibold text-[#171717]">{entry.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

export const PlatformAdminPortal: React.FC = () => {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // View tab: Tree vs Directory vs Analytics vs Security vs Licensing
  const [tab, setTab] = useState<'TREE' | 'DIRECTORY' | 'ANALYTICS' | 'SECURITY' | 'LICENSING'>('TREE');
  const [analyticsData, setAnalyticsData] = useState<PlatformAnalyticsData | null>(null);
  const [analyticsFilter, setAnalyticsFilter] = useState<'ALL' | 'HIGH_ACTIVITY' | 'MODERATE' | 'IDLE'>('ALL');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Licensing Subsystem & Quota Governance
  const [licenses, setLicenses] = useState<any[]>([]);
  const [capacityRequests, setCapacityRequests] = useState<any[]>([]);
  const [selectedLicenseForEdit, setSelectedLicenseForEdit] = useState<any | null>(null);
  const [editLicenseForm, setEditLicenseForm] = useState<any>({
    planTier: 'ENTERPRISE',
    status: 'ACTIVE',
    maxEmployees: 500,
    maxUsers: 100,
    maxSites: 10,
    maxWorkspaces: 5,
    endDate: '',
    gracePeriodDays: 14,
    modules: {},
  });
  const [showEditLicenseModal, setShowEditLicenseModal] = useState(false);

  // Global Platform Audit Trail & Emergency Resets
  const [auditData, setAuditData] = useState<PlatformAuditResponse | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditTenantFilter, setAuditTenantFilter] = useState('');
  const [emergencyResetsLedger, setEmergencyResetsLedger] = useState<EmergencyResetLedgerItem[]>([]);

  // Emergency Reset Modal
  const [showEmergencyResetModal, setShowEmergencyResetModal] = useState(false);
  const [targetAdminForReset, setTargetAdminForReset] = useState<{ id: string; username: string; displayName?: string; email?: string; orgName?: string; orgCode?: string } | null>(null);
  const [resetMethod, setResetMethod] = useState<'TEMPORARY_PASSWORD' | 'RESET_LINK' | 'BOTH'>('BOTH');
  const [resetResult, setResetResult] = useState<EmergencyResetResult | null>(null);
  const [resetCopied, setResetCopied] = useState<'PWD' | 'LINK' | null>(null);

  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Organisations list & Hierarchy Tree data
  const [organizations, setOrganizations] = useState<PlatformOrg[]>([]);
  const [treeData, setTreeData] = useState<TreeData | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');

  // Modal: Organisation Provisioning
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [newOrgForm, setNewOrgForm] = useState({
    name: '',
    code: '',
    legalName: '',
    timezone: 'UTC',
    currency: 'USD',
    adminUser: 'admin',
    adminPassword: '',
    adminEmail: '',
  });
  const [createdOrgSummary, setCreatedOrgSummary] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);

  // Modal: Commercial License Provisioning
  const [showIssueLicenseModal, setShowIssueLicenseModal] = useState(false);
  const [issueLicenseForm, setIssueLicenseForm] = useState({
    tenantId: '',
    planTier: 'ENTERPRISE',
    maxEmployees: 355,
    maxUsers: 75,
    maxSites: 10,
    maxWorkspaces: 5,
    gracePeriodDays: 14,
    endDate: '',
    modules: {
      FORECASTING: true,
      SCHEDULING: true,
      INTRADAY: true,
      ADHERENCE: true,
      TIME_OFF: true,
      SHIFT_BIDDING: true,
      EMPLOYEE_SELF_SERVICE: true,
      REPORTING: true,
      AI_COPILOT: false,
    } as Record<string, boolean>,
  });
  const [createdLicenseSummary, setCreatedLicenseSummary] = useState<any | null>(null);
  const [licenseCopied, setLicenseCopied] = useState(false);

  // Manage Workspaces Modal
  const [selectedOrgForWs, setSelectedOrgForWs] = useState<PlatformOrg | null>(null);
  const [orgWorkspaces, setOrgWorkspaces] = useState<OrgWorkspace[]>([]);
  const [showAddWsForm, setShowAddWsForm] = useState(false);
  const [newWsForm, setNewWsForm] = useState({
    name: '',
    code: '',
    slug: '',
    description: '',
    timezone: 'UTC',
    currency: 'USD',
  });

  // Add Admin Modal
  const [selectedOrgForAdmin, setSelectedOrgForAdmin] = useState<PlatformOrg | null>(null);
  const [newAdminForm, setNewAdminForm] = useState({
    username: '',
    password: '',
    displayName: '',
    email: '',
  });

  // Edit Org Modal
  const [selectedOrgForEdit, setSelectedOrgForEdit] = useState<PlatformOrg | null>(null);
  const [editOrgForm, setEditOrgForm] = useState({
    displayName: '',
    legalName: '',
    contactName: '',
    contactEmail: '',
    timezone: 'UTC',
    currency: 'USD',
  });

  // Initial authentication check
  useEffect(() => {
    const token = localStorage.getItem(PLATFORM_TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    platformApi<{ admin: PlatformAdmin }>('/auth/me')
      .then((data) => {
        setAdmin(data.admin);
        return loadData();
      })
      .catch(() => {
        localStorage.removeItem(PLATFORM_TOKEN_KEY);
        setAdmin(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const loadData = async () => {
    try {
      const [orgs, treeRes, analyticsRes, auditRes, resetsRes, licRes, reqsRes] = await Promise.all([
        platformApi<PlatformOrg[]>('/organizations'),
        platformApi<TreeData>('/tree').catch(() => null),
        platformApi<PlatformAnalyticsData>('/analytics').catch(() => null),
        platformApi<PlatformAuditResponse>('/audit?limit=50').catch(() => null),
        platformApi<EmergencyResetLedgerItem[]>('/emergency-resets').catch(() => []),
        platformApi<any[]>('/licenses').catch(() => []),
        platformApi<any[]>('/capacity-requests').catch(() => []),
      ]);
      setOrganizations(orgs);
      if (licRes) setLicenses(licRes);
      if (reqsRes) setCapacityRequests(reqsRes);
      if (treeRes) {
        setTreeData(treeRes);
        // Expand all nodes by default for instant visibility
        setExpandedNodes((prev) => {
          const next = { ...prev };
          treeRes.tree.forEach((o) => {
            if (next[o.id] === undefined) next[o.id] = true;
            if (next[`${o.id}_ws`] === undefined) next[`${o.id}_ws`] = true;
            if (next[`${o.id}_admins`] === undefined) next[`${o.id}_admins`] = true;
          });
          return next;
        });
      }
      if (analyticsRes) setAnalyticsData(analyticsRes);
      if (auditRes) setAuditData(auditRes);
      if (resetsRes) setEmergencyResetsLedger(resetsRes);
    } catch (err: any) {
      setError(err.message || 'Failed to load organisations');
    }
  };

  const fetchAuditLogs = async (query = search, action = auditActionFilter, tenant = auditTenantFilter) => {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.append('search', query.trim());
      if (action) params.append('action', action);
      if (tenant) params.append('tenantId', tenant);
      params.append('limit', '50');
      const res = await platformApi<PlatformAuditResponse>(`/audit?${params.toString()}`);
      setAuditData(res);
      const resets = await platformApi<EmergencyResetLedgerItem[]>('/emergency-resets').catch(() => []);
      setEmergencyResetsLedger(resets);
    } catch (err: any) {
      setError(err.message || 'Failed to refresh audit log');
    }
  };

  const handlePerformEmergencyReset = async () => {
    if (!targetAdminForReset) return;
    setBusy(true);
    setError('');
    try {
      const res = await platformApi<EmergencyResetResult>('/emergency-reset', {
        method: 'POST',
        body: JSON.stringify({
          userId: targetAdminForReset.id,
          method: resetMethod,
        }),
      });
      setResetResult(res);
      setNotice(`Emergency credential reset generated for ${targetAdminForReset.username}.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Emergency reset failed');
    } finally {
      setBusy(false);
    }
  };

  // Auto-refresh telemetry & audit every 30 seconds when on the analytics or security tab
  useEffect(() => {
    if (!admin || !autoRefresh || (tab !== 'ANALYTICS' && tab !== 'SECURITY')) return;
    const interval = setInterval(() => {
      if (tab === 'ANALYTICS') {
        platformApi<PlatformAnalyticsData>('/analytics')
          .then((data) => setAnalyticsData(data))
          .catch(() => {});
      } else if (tab === 'SECURITY') {
        fetchAuditLogs();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [admin, autoRefresh, tab, auditActionFilter, auditTenantFilter, search]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await platformApi<{ token: string; admin: PlatformAdmin }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      localStorage.setItem(PLATFORM_TOKEN_KEY, res.token);
      setAdmin(res.admin);
      setLoginPassword('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Invalid super admin credentials');
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
    setAdmin(null);
    setOrganizations([]);
    setTreeData(null);
    setAnalyticsData(null);
    setAuditData(null);
    setEmergencyResetsLedger([]);
  };

  const openProvisionModal = () => {
    setCreatedOrgSummary(null);
    setNewOrgForm({
      name: '',
      code: '',
      legalName: '',
      timezone: 'UTC',
      currency: 'USD',
      adminUser: 'admin',
      adminPassword: '',
      adminEmail: '',
    });
    setShowNewOrg(true);
  };

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgForm.name.trim() || !newOrgForm.code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const payload: any = {
        name: newOrgForm.name.trim(),
        code: newOrgForm.code.trim().toUpperCase(),
        legalName: newOrgForm.legalName.trim() || undefined,
        timezone: newOrgForm.timezone,
        currency: newOrgForm.currency,
      };
      if (newOrgForm.adminUser && newOrgForm.adminPassword) {
        payload.adminUser = newOrgForm.adminUser.trim();
        payload.adminPassword = newOrgForm.adminPassword;
        if (newOrgForm.adminEmail) payload.adminEmail = newOrgForm.adminEmail.trim();
      }

      const res = await platformApi<any>('/organizations', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setCreatedOrgSummary({
        org: res.organization,
        workspace: res.workspace,
        adminUser: newOrgForm.adminUser,
        adminPassword: newOrgForm.adminPassword,
      });

      setNotice(`Organisation "${res.organization.name}" provisioned successfully.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to provision organisation');
    } finally {
      setBusy(false);
    }
  };

  const unlicensedOrgs = organizations.filter(
    (org) => !licenses.some((lic) => lic.tenantId === org.id && lic.status !== 'CANCELLED')
  );

  const openIssueLicenseModal = (preselectedTenantId?: string) => {
    setCreatedLicenseSummary(null);
    const unlicensed = organizations.filter(
      (org) => !licenses.some((lic) => lic.tenantId === org.id && lic.status !== 'CANCELLED')
    );
    const targetId = preselectedTenantId || (unlicensed[0]?.id ?? '');
    const oneYearAhead = new Date();
    oneYearAhead.setFullYear(oneYearAhead.getFullYear() + 1);

    const modMap: Record<string, boolean> = {
      FORECASTING: true,
      SCHEDULING: true,
      INTRADAY: true,
      ADHERENCE: true,
      TIME_OFF: true,
      SHIFT_BIDDING: true,
      EMPLOYEE_SELF_SERVICE: true,
      REPORTING: true,
      AI_COPILOT: false,
    };

    setIssueLicenseForm({
      tenantId: targetId,
      planTier: 'ENTERPRISE',
      maxEmployees: 355,
      maxUsers: 75,
      maxSites: 10,
      maxWorkspaces: 5,
      gracePeriodDays: 14,
      endDate: oneYearAhead.toISOString().slice(0, 10),
      modules: modMap,
    });
    setShowIssueLicenseModal(true);
  };

  const handleIssueLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueLicenseForm.tenantId) {
      setError('Please select an organisation to issue a license.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const enabledModules = Object.keys(issueLicenseForm.modules).filter((k) => issueLicenseForm.modules[k]);
      const res = await platformApi<any>('/licenses', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: issueLicenseForm.tenantId,
          planTier: issueLicenseForm.planTier,
          maxEmployees: Number(issueLicenseForm.maxEmployees),
          maxUsers: Number(issueLicenseForm.maxUsers),
          maxSites: Number(issueLicenseForm.maxSites),
          maxWorkspaces: Number(issueLicenseForm.maxWorkspaces),
          gracePeriodDays: Number(issueLicenseForm.gracePeriodDays),
          endDate: issueLicenseForm.endDate ? new Date(issueLicenseForm.endDate).toISOString() : undefined,
          modules: enabledModules,
        }),
      });

      const org = organizations.find((o) => o.id === issueLicenseForm.tenantId) || res.organization;
      setCreatedLicenseSummary({
        org: org || { name: 'Organisation', code: '' },
        license: res.license,
      });

      setNotice(`Commercial license (${res.license?.license_key || 'issued'}) provisioned for "${org?.name || 'Organisation'}".`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to issue license');
    } finally {
      setBusy(false);
    }
  };

  const openWorkspacesModal = async (org: PlatformOrg | TreeOrg) => {
    setSelectedOrgForWs(org as PlatformOrg);
    setShowAddWsForm(false);
    setNewWsForm({
      name: '',
      code: '',
      slug: '',
      description: '',
      timezone: org.timezone || 'UTC',
      currency: org.currency || 'USD',
    });
    try {
      const ws = await platformApi<OrgWorkspace[]>(`/organizations/${org.id}/workspaces`);
      setOrgWorkspaces(ws);
    } catch (err: any) {
      setError(err.message || 'Failed to load workspaces');
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgForWs || !newWsForm.name || !newWsForm.code) return;
    setBusy(true);
    setError('');
    try {
      await platformApi(`/organizations/${selectedOrgForWs.id}/workspaces`, {
        method: 'POST',
        body: JSON.stringify({
          name: newWsForm.name.trim(),
          code: newWsForm.code.trim().toUpperCase(),
          slug: newWsForm.slug.trim().toLowerCase() || undefined,
          description: newWsForm.description.trim() || undefined,
          timezone: newWsForm.timezone,
          currency: newWsForm.currency,
        }),
      });
      setShowAddWsForm(false);
      setNewWsForm({
        name: '',
        code: '',
        slug: '',
        description: '',
        timezone: selectedOrgForWs.timezone || 'UTC',
        currency: selectedOrgForWs.currency || 'USD',
      });
      const updated = await platformApi<OrgWorkspace[]>(`/organizations/${selectedOrgForWs.id}/workspaces`);
      setOrgWorkspaces(updated);
      setNotice('Workspace created successfully.');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgForAdmin || !newAdminForm.username || !newAdminForm.password) return;
    setBusy(true);
    setError('');
    try {
      await platformApi(`/organizations/${selectedOrgForAdmin.id}/admin`, {
        method: 'POST',
        body: JSON.stringify({
          username: newAdminForm.username.trim(),
          password: newAdminForm.password,
          displayName: newAdminForm.displayName.trim() || undefined,
          email: newAdminForm.email.trim() || undefined,
        }),
      });
      setSelectedOrgForAdmin(null);
      setNewAdminForm({ username: '', password: '', displayName: '', email: '' });
      setNotice(`Administrator "${newAdminForm.username}" provisioned for ${selectedOrgForAdmin.name}.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to provision administrator');
    } finally {
      setBusy(false);
    }
  };

  const openEditOrgModal = (org: PlatformOrg | TreeOrg) => {
    setSelectedOrgForEdit(org as PlatformOrg);
    setEditOrgForm({
      displayName: org.displayName || org.display_name || org.name,
      legalName: org.legalName || org.legal_name || org.name,
      contactName: org.contactName || org.contact_name || '',
      contactEmail: org.contactEmail || org.contact_email || '',
      timezone: org.timezone || 'UTC',
      currency: org.currency || 'USD',
    });
  };

  const handleSaveOrgEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgForEdit) return;
    setBusy(true);
    setError('');
    try {
      await platformApi(`/organizations/${selectedOrgForEdit.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editOrgForm),
      });
      setSelectedOrgForEdit(null);
      setNotice(`Organisation "${selectedOrgForEdit.name}" updated successfully.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to update organisation');
    } finally {
      setBusy(false);
    }
  };

  const openEditLicenseModal = (lic: any) => {
    setSelectedLicenseForEdit(lic);
    const ALL_MODULE_CODES = [
      'FORECASTING',
      'SCHEDULING',
      'INTRADAY',
      'ADHERENCE',
      'TIME_OFF',
      'SHIFT_BIDDING',
      'EMPLOYEE_SELF_SERVICE',
      'REPORTING',
      'AI_COPILOT',
    ];
    const modMap: Record<string, boolean> = {};
    const enabledList = Array.isArray(lic.enabledModules) ? lic.enabledModules : (Array.isArray(lic.enabled_modules) ? lic.enabled_modules : []);
    ALL_MODULE_CODES.forEach((m) => {
      modMap[m] = enabledList.includes(m);
    });
    setEditLicenseForm({
      planTier: lic.planTier || 'ENTERPRISE',
      status: lic.status || 'ACTIVE',
      maxEmployees: lic.maxEmployees || 500,
      maxUsers: lic.maxUsers || 100,
      maxSites: lic.maxSites || 10,
      maxWorkspaces: lic.maxWorkspaces || 5,
      endDate: lic.endDate ? lic.endDate.slice(0, 10) : '',
      gracePeriodDays: lic.gracePeriodDays ?? 14,
      modules: modMap,
    });
    setShowEditLicenseModal(true);
  };

  const handleSaveLicenseEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLicenseForEdit) return;
    setBusy(true);
    setError('');
    try {
      await platformApi(`/licenses/${selectedLicenseForEdit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          planTier: editLicenseForm.planTier,
          status: editLicenseForm.status,
          maxEmployees: Number(editLicenseForm.maxEmployees),
          maxUsers: Number(editLicenseForm.maxUsers),
          maxSites: Number(editLicenseForm.maxSites),
          maxWorkspaces: Number(editLicenseForm.maxWorkspaces),
          gracePeriodDays: Number(editLicenseForm.gracePeriodDays),
          endDate: editLicenseForm.endDate ? new Date(editLicenseForm.endDate).toISOString() : undefined,
          modules: editLicenseForm.modules,
        }),
      });
      setShowEditLicenseModal(false);
      setSelectedLicenseForEdit(null);
      setNotice(`License for "${selectedLicenseForEdit.tenantName}" updated successfully.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to update license');
    } finally {
      setBusy(false);
    }
  };

  const handleDecideRequest = async (requestId: string, action: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    setError('');
    try {
      await platformApi(`/capacity-requests/${requestId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setNotice(`Capacity request ${action === 'APPROVE' ? 'approved and license capacity updated' : 'rejected'}.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to decide request');
    } finally {
      setBusy(false);
    }
  };

  const toggleNode = (nodeKey: string) => {
    setExpandedNodes((prev) => ({
      ...prev,
      [nodeKey]: !prev[nodeKey],
    }));
  };

  const expandAll = () => {
    if (!treeData) return;
    const all: Record<string, boolean> = {};
    treeData.tree.forEach((o) => {
      all[o.id] = true;
      all[`${o.id}_ws`] = true;
      all[`${o.id}_admins`] = true;
    });
    setExpandedNodes(all);
  };

  const collapseAll = () => {
    setExpandedNodes({});
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center text-[#171717]">
        <div className="flex items-center gap-3">
          <RefreshCw className="w-5 h-5 animate-spin text-[#171717]" />
          <span className="text-sm font-medium text-[#737373]">Checking platform authentication...</span>
        </div>
      </div>
    );
  }

  // Login Screen (Clean White Theme)
  if (!admin) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] text-[#171717] flex flex-col items-center justify-center p-4 font-sans antialiased">
        <div className="w-full max-w-sm bg-white border border-[#E5E5E0] rounded-lg shadow-xs p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded bg-[#171717] flex items-center justify-center text-white font-bold text-sm tracking-wider">
              <ShieldAlert className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-[16px] font-semibold text-[#171717] leading-tight">Platform Super Admin</h1>
              <p className="text-[12px] text-[#737373]">Root multi-tenant portal · Token isolation</p>
            </div>
          </div>

          {error && (
            <div className="text-[12px] text-[#C84A4A] bg-[#FCEBEC] border border-[#C84A4A]/20 rounded px-3 py-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-[#C84A4A]" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-3">
            <div>
              <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                Admin Email
              </label>
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="superadmin@wfm.local"
                required
                autoFocus
                className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] placeholder-[#737373] focus:outline-none focus:border-[#171717]"
              />
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                Password
              </label>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] placeholder-[#737373] focus:outline-none focus:border-[#171717]"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full px-4 py-2 rounded bg-[#171717] hover:bg-[#333333] text-white text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60 transition-colors shadow-xs"
            >
              <Key className="w-4 h-4" />
              {busy ? 'Authenticating...' : 'Sign In as Super Admin'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Filter Directory Table
  const filteredOrgs = organizations.filter(
    (o) =>
      o.name.toLowerCase().includes(search.toLowerCase()) ||
      o.code.toLowerCase().includes(search.toLowerCase()) ||
      ((o.displayName || o.display_name) && (o.displayName || o.display_name)!.toLowerCase().includes(search.toLowerCase()))
  );

  // Filter Tree Structure
  const treeList = treeData?.tree || [];
  const filteredTreeOrgs = treeList.filter((o) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const matchOrg = o.name.toLowerCase().includes(q) ||
      o.code.toLowerCase().includes(q) ||
      o.displayName.toLowerCase().includes(q) ||
      o.legalName.toLowerCase().includes(q);
    const matchWs = o.workspaces.some((w) => w.name.toLowerCase().includes(q) || w.code.toLowerCase().includes(q) || w.slug.toLowerCase().includes(q));
    const matchAdmin = o.admins.some((a) => a.username.toLowerCase().includes(q) || (a.email && a.email.toLowerCase().includes(q)) || (a.displayName && a.displayName.toLowerCase().includes(q)));
    return matchOrg || matchWs || matchAdmin;
  });

  // Filter Telemetry Tenants
  const telemetryList = analyticsData?.tenants || [];
  const filteredTelemetryTenants = telemetryList.filter((t) => {
    if (analyticsFilter !== 'ALL' && t.statusTier !== analyticsFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.code.toLowerCase().includes(q) ||
      t.displayName.toLowerCase().includes(q) ||
      t.legalName.toLowerCase().includes(q)
    );
  });

  const totalWorkspaces = organizations.reduce((acc, o) => acc + (o.workspaceCount ?? o.workspace_count ?? 0), 0);
  const totalUsers = organizations.reduce((acc, o) => acc + (o.userCount ?? o.user_count ?? 0), 0);
  const treeTotalWorkspaces = treeData?.platform.totalWorkspaces ?? totalWorkspaces;
  const treeTotalAdmins = treeData?.platform.totalAdmins ?? 0;

  return (
    <div className="h-screen bg-[#FAFAF8] text-[#171717] flex flex-col font-sans antialiased overflow-hidden">
      {/* Platform Navigation Header (Clean White Theme & Fixed at top) */}
      <header className="h-14 border-b border-[#E5E5E0] bg-[#FFFFFF] px-6 flex items-center justify-between shrink-0 select-none z-30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded bg-[#171717] flex items-center justify-center text-white">
            <ShieldAlert className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#171717] text-[15px] tracking-tight">Enterprise WFM</span>
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20">
                Platform Super Admin
              </span>
            </div>
            <div className="text-[12px] text-[#737373]">Multi-tenant provisioning & infrastructure root</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[12px] font-medium text-[#171717]">{admin.email}</div>
            <div className="text-[10px] text-[#2F7D5A] font-mono font-semibold">STATUS: {admin.status}</div>
          </div>
          <button
            onClick={() => {
              window.open('http://localhost:3000', '_blank');
            }}
            title="Open tenant web application on localhost:3000"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] text-[12px] font-semibold transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Tenant App (:3000)
          </button>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#C84A4A]/20 bg-[#FCEBEC] hover:bg-[#F8D7DA] text-[#C84A4A] text-[12px] font-semibold transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign Out
          </button>
        </div>
      </header>

      {/* 2-Column Shell: Left Side Menu Bar + Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Side Menu Bar: Completely Stable & Locked */}
        <aside className="w-60 border-r border-[#E5E5E0] bg-[#FAFAF8] flex flex-col justify-between select-none shrink-0 h-full overflow-y-auto">
          <div className="p-3 space-y-1">
            <div className="px-2 py-1.5 text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
              Platform Modules
            </div>

            <button
              onClick={() => setTab('TREE')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                tab === 'TREE'
                  ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                  : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <FolderTree className={`w-4 h-4 ${tab === 'TREE' ? 'text-[#171717]' : 'text-[#737373]'}`} />
                <span>Hierarchy Tree</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                {filteredTreeOrgs.length}
              </span>
            </button>

            <button
              onClick={() => setTab('DIRECTORY')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                tab === 'DIRECTORY'
                  ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                  : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Building2 className={`w-4 h-4 ${tab === 'DIRECTORY' ? 'text-[#171717]' : 'text-[#737373]'}`} />
                <span>Organisations</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                {filteredOrgs.length}
              </span>
            </button>

            <button
              onClick={() => setTab('ANALYTICS')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                tab === 'ANALYTICS'
                  ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                  : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <BarChart3 className={`w-4 h-4 ${tab === 'ANALYTICS' ? 'text-[#171717]' : 'text-[#737373]'}`} />
                <span>Analytics & Telemetry</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#EAF5EF] border border-[#2F7D5A]/20 text-[#2F7D5A] font-semibold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2F7D5A] animate-pulse" />
                Live
              </span>
            </button>

            <button
              onClick={() => {
                setTab('SECURITY');
                fetchAuditLogs();
              }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                tab === 'SECURITY'
                  ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                  : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <ShieldCheck className={`w-4 h-4 ${tab === 'SECURITY' ? 'text-[#171717]' : 'text-[#737373]'}`} />
                <span>Audit & Security</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                {auditData?.stats.totalEvents ?? 0}
              </span>
            </button>

            <button
              onClick={() => {
                setTab('LICENSING');
                loadData();
              }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-[13px] font-medium transition-colors ${
                tab === 'LICENSING'
                  ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                  : 'text-[#525252] hover:bg-[#F5F5F2] hover:text-[#171717]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <KeyRound className={`w-4 h-4 ${tab === 'LICENSING' ? 'text-[#171717]' : 'text-[#737373]'}`} />
                <span>Licensing & Provisioning</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                {licenses.length}
              </span>
            </button>
          </div>

          {/* Sidebar Footer Status */}
          <div className="p-3 border-t border-[#E5E5E0] bg-white m-3 rounded-lg border text-[11px] space-y-1.5 text-[#737373]">
            <div className="font-semibold text-[#171717] flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-[#2F7D5A]" />
              <span>Platform Guard</span>
            </div>
            <div>Audience isolation enforced with platform secret.</div>
            <div className="font-mono text-[10px] text-[#2F7D5A] pt-1 border-t border-[#E5E5E0]">
              STATUS: {admin.status}
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#FAFAF8]">
          {notice && (
            <div className="flex items-center justify-between gap-3 text-[13px] rounded px-3.5 py-2.5 border bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-[#2F7D5A]" />
                <span>{notice}</span>
              </div>
              <button onClick={() => setNotice('')} className="text-[#2F7D5A] hover:underline text-[12px]">✕</button>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-between gap-3 text-[13px] rounded px-3.5 py-2.5 border bg-[#FCEBEC] text-[#C84A4A] border-[#C84A4A]/20">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-[#C84A4A]" />
                <span>{error}</span>
              </div>
              <button onClick={() => setError('')} className="text-[#C84A4A] hover:underline text-[12px]">✕</button>
            </div>
          )}

          {/* Overview Stats */}
          {tab === 'ANALYTICS' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Organisations</span>
                  <Building2 className="w-3.5 h-3.5 text-[#737373]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {analyticsData?.platform.totalOrgs ?? organizations.length}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  {analyticsData?.platform.totalWorkspaces ?? totalWorkspaces} active workspaces
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Seat Capacity</span>
                  <Users className="w-3.5 h-3.5 text-[#2F7D5A]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {analyticsData?.platform.totalActiveUsers ?? totalUsers} <span className="text-[14px] font-normal text-[#737373]">/ {analyticsData?.platform.totalUsers ?? totalUsers}</span>
                </div>
                <div className="text-[11px] text-[#2F7D5A] mt-0.5 font-medium">
                  Active user seats · {analyticsData?.platform.totalEmployees ?? 0} employees
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Schedules & Shifts</span>
                  <Clock className="w-3.5 h-3.5 text-[#4F6F8F]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {analyticsData?.platform.totalShifts?.toLocaleString() ?? 0}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  {analyticsData?.platform.totalSchedules ?? 0} versions ({analyticsData?.platform.totalPublishedSchedules ?? 0} published)
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Timeseries Intervals</span>
                  <HardDrive className="w-3.5 h-3.5 text-[#7A62A8]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {analyticsData?.platform.totalIntervals?.toLocaleString() ?? 0}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  15-min intervals · {analyticsData?.platform.totalForecasts ?? 0} models
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Platform Guard</span>
                  <Activity className="w-3.5 h-3.5 text-[#2F7D5A]" />
                </div>
                <div className="text-[22px] font-bold text-[#2F7D5A] mt-1 flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#2F7D5A] animate-pulse" />
                  <span>OPTIMAL</span>
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  {analyticsData?.platform.totalAuditLogs ?? 0} audit events · 99.98% uptime
                </div>
              </div>
            </div>
          ) : tab === 'SECURITY' ? (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3.5">
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Total Audit Events</span>
                  <ScrollText className="w-3.5 h-3.5 text-[#171717]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {auditData?.stats?.totalEvents ?? 0}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  Immutable platform ledger
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Admin Sessions</span>
                  <ShieldCheck className="w-3.5 h-3.5 text-[#4F6F8F]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {auditData?.stats?.sessionEvents ?? 0}
                </div>
                <div className="text-[11px] text-[#4F6F8F] mt-0.5 font-medium">
                  Super Admin sign-ins logged
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Provisioning Events</span>
                  <Building2 className="w-3.5 h-3.5 text-[#2F7D5A]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {auditData?.stats?.provisioningEvents ?? 0}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  Orgs & workspaces created
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Emergency Resets</span>
                  <KeyRound className="w-3.5 h-3.5 text-[#B35900]" />
                </div>
                <div className="text-[22px] font-bold tabular-nums font-mono text-[#B35900] mt-1">
                  {auditData?.stats?.credentialResets ?? 0}
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  {emergencyResetsLedger.filter((r) => (r.token_status || (r as any).tokenStatus) === 'ACTIVE').length} active recovery token{emergencyResetsLedger.filter((r) => (r.token_status || (r as any).tokenStatus) === 'ACTIVE').length !== 1 ? 's' : ''}
                </div>
              </div>

              <div className="bg-white border border-[#E5E5E0] rounded-lg p-3.5 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider flex items-center justify-between">
                  <span>Security State</span>
                  <ShieldAlert className="w-3.5 h-3.5 text-[#2F7D5A]" />
                </div>
                <div className="text-[22px] font-bold text-[#2F7D5A] mt-1 flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#2F7D5A] animate-pulse" />
                  <span>ENFORCED</span>
                </div>
                <div className="text-[11px] text-[#737373] mt-0.5">
                  Tenant RLS & Token Hashing
                </div>
              </div>
            </div>
          ) : tab === 'LICENSING' ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Active Licenses</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">{licenses.length}</div>
                <div className="text-[12px] text-[#737373] mt-0.5">Commercial contracts</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Total Licensed Employees</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {licenses.reduce((acc, l) => acc + (l.maxEmployees || 0), 0)}
                </div>
                <div className="text-[12px] text-[#737373] mt-0.5">Maximum headcount limit</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Active Employees Managed</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">
                  {licenses.reduce((acc, l) => acc + (l.activeEmployees || 0), 0)}
                </div>
                <div className="text-[12px] text-[#737373] mt-0.5">Currently scheduled agents</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Capacity Requests</div>
                <div className={`text-[24px] font-bold tabular-nums font-mono mt-1 ${capacityRequests.filter((r: any) => r.status === 'PENDING').length > 0 ? 'text-[#DC2626]' : 'text-[#171717]'}`}>
                  {capacityRequests.filter((r: any) => r.status === 'PENDING').length} Pending
                </div>
                <div className="text-[12px] text-[#737373] mt-0.5">Customer upgrade inquiries</div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Total Organisations</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">{organizations.length}</div>
                <div className="text-[12px] text-[#737373] mt-0.5">Isolated tenant boundaries</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Total Workspaces</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">{totalWorkspaces}</div>
                <div className="text-[12px] text-[#737373] mt-0.5">Operating units across orgs</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Total Tenant Users</div>
                <div className="text-[24px] font-bold tabular-nums font-mono text-[#171717] mt-1">{totalUsers}</div>
                <div className="text-[12px] text-[#737373] mt-0.5">Active personnel accounts</div>
              </div>
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-4 shadow-xs">
                <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider">Super Admin Access</div>
                <div className="text-[24px] font-bold text-[#2F7D5A] mt-1">Platform Guard</div>
                <div className="text-[12px] text-[#737373] mt-0.5">CLI provisioned credentials</div>
              </div>
            </div>
          )}

          {/* Module Action & Search Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E5E0] pb-3">
            <div>
              <h2 className="text-[18px] font-bold text-[#171717] flex items-center gap-2">
                {tab === 'TREE' ? (
                  <>
                    <FolderTree className="w-5 h-5 text-[#171717]" /> Multi-Tenant Hierarchy Tree
                  </>
                ) : tab === 'ANALYTICS' ? (
                  <>
                    <BarChart3 className="w-5 h-5 text-[#171717]" /> Cross-Tenant Analytics & Capacity Telemetry
                  </>
                ) : tab === 'SECURITY' ? (
                  <>
                    <ShieldCheck className="w-5 h-5 text-[#171717]" /> Global Platform Audit Trail & Security
                  </>
                ) : tab === 'LICENSING' ? (
                  <>
                    <KeyRound className="w-5 h-5 text-[#171717]" /> License Subsystem & Quota Governance
                  </>
                ) : (
                  <>
                    <Building2 className="w-5 h-5 text-[#171717]" /> Managed Organisations Directory
                  </>
                )}
              </h2>
              <p className="text-[12px] text-[#737373] mt-0.5">
                {tab === 'TREE'
                  ? 'Interactive hierarchical structural tree: Platform → Organisations → Workspaces & Admins.'
                  : tab === 'ANALYTICS'
                  ? 'Real-time multi-tenant resource consumption, operational workload, and capacity distribution across isolated tenant boundaries.'
                  : tab === 'SECURITY'
                  ? 'Immutable cross-organization audit trail tracking administrative sign-ins, IP addresses, tenant provisioning, and emergency credential resets.'
                  : tab === 'LICENSING'
                  ? 'First-class license contract governance: quota capacity (employees, users, sites), modular feature activation, and lifecycle grace periods.'
                  : 'Complete tenant catalog with strict row-level isolation and per-tenant settings.'}
              </p>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <input
                type="text"
                placeholder={
                  tab === 'TREE'
                    ? "Search tree nodes..."
                    : tab === 'ANALYTICS'
                    ? "Search telemetry..."
                    : tab === 'SECURITY'
                    ? "Search audit trail (admin, IP, action)..."
                    : "Search organisations..."
                }
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (tab === 'SECURITY') {
                    fetchAuditLogs(e.target.value, auditActionFilter, auditTenantFilter);
                  }
                }}
                className="px-3 py-1.5 bg-white border border-[#E5E5E0] rounded text-[13px] text-[#171717] placeholder-[#737373] w-64 focus:outline-none focus:border-[#171717]"
              />

              {tab === 'SECURITY' && (
                <>
                  <select
                    value={auditActionFilter}
                    onChange={(e) => {
                      setAuditActionFilter(e.target.value);
                      fetchAuditLogs(search, e.target.value, auditTenantFilter);
                    }}
                    className="px-2.5 py-1.5 bg-white border border-[#E5E5E0] rounded text-[12px] text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    <option value="">All Actions</option>
                    <option value="SIGN_IN">Sign In</option>
                    <option value="SIGN_OUT">Sign Out</option>
                    <option value="SIGN_IN_FAILED">Failed Sign In</option>
                    <option value="PROVISION_ORGANISATION">Provision Organisation</option>
                    <option value="UPDATE_ORGANISATION">Update Organisation</option>
                    <option value="CREATE_WORKSPACE">Create Workspace</option>
                    <option value="PROVISION_ADMIN">Provision Admin</option>
                    <option value="EMERGENCY_CREDENTIAL_RESET">Emergency Reset (Issued)</option>
                    <option value="EMERGENCY_RESET_COMPLETED">Emergency Reset (Completed)</option>
                  </select>

                  <select
                    value={auditTenantFilter}
                    onChange={(e) => {
                      setAuditTenantFilter(e.target.value);
                      fetchAuditLogs(search, auditActionFilter, e.target.value);
                    }}
                    className="px-2.5 py-1.5 bg-white border border-[#E5E5E0] rounded text-[12px] text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    <option value="">All Organisations</option>
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name} ({org.code})
                      </option>
                    ))}
                  </select>
                </>
              )}

              {tab === 'ANALYTICS' && (
                <button
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[12px] font-semibold transition-colors ${
                    autoRefresh
                      ? 'bg-[#EAF5EF] border-[#2F7D5A]/30 text-[#2F7D5A]'
                      : 'bg-white border-[#E5E5E0] text-[#737373] hover:text-[#171717]'
                  }`}
                  title="Toggle 30-second live telemetry polling"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>Auto: {autoRefresh ? 'On (30s)' : 'Off'}</span>
                </button>
              )}

              <button
                onClick={() => {
                  if (tab === 'SECURITY') {
                    fetchAuditLogs();
                  } else {
                    loadData();
                  }
                }}
                className="p-1.5 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] transition-colors"
                title="Refresh list"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={openProvisionModal}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#171717] hover:bg-[#333333] text-white text-[12px] font-semibold transition-colors shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" /> Provision Organisation
              </button>
            </div>
          </div>

        {/* TAB 1: Interactive Hierarchical Tree View */}
        {tab === 'TREE' && (
          <div className="border border-[#E5E5E0] rounded-lg bg-white shadow-xs p-5 space-y-4">
            {/* Tree controls bar: Expand all, collapse all, stats */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#E5E5E0] text-[12px]">
              <div className="flex items-center gap-2">
                <span className="text-[#737373] font-medium">Tree View Controls:</span>
                <button
                  onClick={expandAll}
                  className="px-2.5 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] font-medium transition-colors"
                >
                  Expand All
                </button>
                <button
                  onClick={collapseAll}
                  className="px-2.5 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] font-medium transition-colors"
                >
                  Collapse All
                </button>
              </div>

              <div className="text-[12px] text-[#737373] flex items-center gap-3">
                <span><strong>{filteredTreeOrgs.length}</strong> Organisation{filteredTreeOrgs.length !== 1 ? 's' : ''}</span>
                <span>·</span>
                <span><strong>{treeTotalWorkspaces}</strong> Workspaces</span>
                <span>·</span>
                <span><strong>{treeTotalAdmins}</strong> Administrators</span>
              </div>
            </div>

            {/* Root Platform Node */}
            <div className="border border-[#E5E5E0] rounded-lg p-3.5 bg-[#FAFAF8] flex items-center justify-between shadow-xs">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#171717] text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-bold text-[14px] text-[#171717] flex items-center gap-2">
                    <span>Platform Root: Enterprise WFM</span>
                    <span className="text-[10px] bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20 px-1.5 py-0.2 rounded font-mono font-semibold">
                      PLATFORM CORE
                    </span>
                  </div>
                  <div className="text-[12px] text-[#737373]">
                    Central infrastructure host · Isolated multi-tenant boundaries
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[#737373] font-medium hidden sm:inline">
                  Click arrow to expand an organisation
                </span>
              </div>
            </div>

            {/* Tree Branches */}
            <div className="space-y-3 pl-3 sm:pl-4 border-l-2 border-[#E5E5E0] ml-3.5 sm:ml-4">
              {filteredTreeOrgs.length === 0 ? (
                <div className="py-8 text-center text-[#737373] text-[13px] border border-dashed border-[#E5E5E0] rounded-lg bg-[#FAFAF8]">
                  No organisations match your search query.
                </div>
              ) : (
                filteredTreeOrgs.map((org) => {
                  const isExpanded = !!expandedNodes[org.id];
                  const isWsExpanded = !!expandedNodes[`${org.id}_ws`];
                  const isAdminsExpanded = !!expandedNodes[`${org.id}_admins`];

                  return (
                    <div key={org.id} className="space-y-2">
                      {/* Organization Node Card */}
                      <div className="border border-[#E5E5E0] rounded-lg bg-white p-3 hover:border-[#171717]/40 transition-colors shadow-xs">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {/* Left: Expand toggle & Org info */}
                          <div className="flex items-center gap-2.5">
                            <button
                              onClick={() => toggleNode(org.id)}
                              className="p-1 rounded hover:bg-[#FAFAF8] text-[#737373] hover:text-[#171717] transition-colors"
                              title={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4 text-[#171717]" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-[#737373]" />
                              )}
                            </button>

                            <div className="w-7 h-7 rounded bg-[#FAFAF8] border border-[#E5E5E0] flex items-center justify-center text-[#171717]">
                              <Building2 className="w-3.5 h-3.5" />
                            </div>

                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-[13px] text-[#171717]">{org.name}</span>
                                <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#171717]">
                                  {org.code}
                                </span>
                                <span className="text-[11px] text-[#737373]">
                                  {org.timezone} · {org.currency}
                                </span>
                              </div>
                              {org.legalName && org.legalName !== org.name && (
                                <div className="text-[11px] text-[#737373]">Legal Entity: {org.legalName}</div>
                              )}
                            </div>
                          </div>

                          {/* Right: Meta pills & Quick Action buttons */}
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                              {org.workspaces.length} workspace{org.workspaces.length !== 1 ? 's' : ''}
                            </span>
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                              {org.admins.length} admin{org.admins.length !== 1 ? 's' : ''}
                            </span>

                            <div className="h-4 w-[1px] bg-[#E5E5E0] hidden sm:block" />

                            <button
                              onClick={() => openWorkspacesModal(org)}
                              className="px-2 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[11px] font-medium flex items-center gap-1 transition-colors"
                              title="Add or view workspaces in this organisation"
                            >
                              <Plus className="w-3 h-3" /> Workspace
                            </button>
                            <button
                              onClick={() => {
                                setSelectedOrgForAdmin(org);
                                setNewAdminForm({ username: 'admin', password: '', displayName: 'Administrator', email: '' });
                              }}
                              className="px-2 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[11px] font-medium flex items-center gap-1 transition-colors"
                              title="Provision a new administrator for this organisation"
                            >
                              <Key className="w-3 h-3" /> Admin
                            </button>
                            {(() => {
                              const existingLic = licenses.find((l) => l.tenantId === org.id && l.status !== 'CANCELLED');
                              return (
                                <button
                                  onClick={() => existingLic ? openEditLicenseModal(existingLic) : openIssueLicenseModal(org.id)}
                                  className="px-2 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[11px] font-medium flex items-center gap-1 transition-colors"
                                  title={existingLic ? "Configure active license for this organisation" : "Issue new commercial license for this organisation"}
                                >
                                  <KeyRound className="w-3 h-3" /> License
                                </button>
                              );
                            })()}
                            <button
                              onClick={() => openEditOrgModal(org)}
                              className="p-1 bg-white hover:bg-[#FAFAF8] text-[#737373] hover:text-[#171717] rounded border border-[#E5E5E0] text-[11px] transition-colors"
                              title="Edit Organisation Settings"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Sub-tree branches when Org is expanded */}
                      {isExpanded && (
                        <div className="space-y-3 pl-5 border-l-2 border-[#E5E5E0] ml-4 pt-1">
                          {/* Workspaces Sub-folder */}
                          <div className="space-y-1.5">
                            <div
                              onClick={() => toggleNode(`${org.id}_ws`)}
                              className="flex items-center gap-1.5 text-[12px] font-semibold text-[#171717] cursor-pointer select-none py-0.5 hover:text-[#2F7D5A] transition-colors"
                            >
                              {isWsExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[#737373]" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[#737373]" />
                              )}
                              <Layers className="w-3.5 h-3.5 text-[#2F7D5A]" />
                              <span>Operational Workspaces</span>
                              <span className="text-[10px] font-mono text-[#737373]">({org.workspaces.length})</span>
                            </div>

                            {isWsExpanded && (
                              <div className="space-y-1.5 pl-4 border-l border-[#E5E5E0] ml-2">
                                {org.workspaces.length === 0 ? (
                                  <div className="text-[11px] text-[#737373] italic py-1">
                                    No workspaces configured yet.
                                  </div>
                                ) : (
                                  org.workspaces.map((w) => (
                                    <div
                                      key={w.id}
                                      className="flex flex-wrap items-center justify-between gap-2 p-2 bg-[#FAFAF8] border border-[#E5E5E0] rounded text-[12px] hover:bg-white hover:border-[#171717]/30 transition-colors"
                                    >
                                      <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-[#2F7D5A]" />
                                        <span className="font-semibold text-[#171717]">{w.name}</span>
                                        {w.isDefault && (
                                          <span className="text-[10px] bg-[#EDF3F8] text-[#4F6F8F] border border-[#4F6F8F]/20 px-1.5 py-0.2 rounded font-mono font-semibold">
                                            DEFAULT
                                          </span>
                                        )}
                                        <span className="font-mono text-[10px] text-[#737373]">
                                          [{w.code}] · {w.slug}
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20 px-1.5 py-0.2 rounded font-semibold">
                                          {w.status}
                                        </span>
                                        <span className="text-[11px] text-[#737373]">
                                          {w.timezone}
                                        </span>
                                        <span className="text-[11px] font-mono text-[#171717] bg-white border border-[#E5E5E0] px-1.5 py-0.5 rounded">
                                          {w.memberCount} member{w.memberCount !== 1 ? 's' : ''}
                                        </span>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>

                          {/* Admins Sub-folder */}
                          <div className="space-y-1.5">
                            <div
                              onClick={() => toggleNode(`${org.id}_admins`)}
                              className="flex items-center gap-1.5 text-[12px] font-semibold text-[#171717] cursor-pointer select-none py-0.5 hover:text-[#171717] transition-colors"
                            >
                              {isAdminsExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[#737373]" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[#737373]" />
                              )}
                              <Key className="w-3.5 h-3.5 text-[#171717]" />
                              <span>Organisation Administrators</span>
                              <span className="text-[10px] font-mono text-[#737373]">({org.admins.length})</span>
                            </div>

                            {isAdminsExpanded && (
                              <div className="space-y-1.5 pl-4 border-l border-[#E5E5E0] ml-2">
                                {org.admins.length === 0 ? (
                                  <div className="text-[11px] text-[#737373] italic py-1 flex items-center justify-between">
                                    <span>No administrator assigned yet.</span>
                                    <button
                                      onClick={() => {
                                        setSelectedOrgForAdmin(org);
                                        setNewAdminForm({ username: 'admin', password: '', displayName: 'Administrator', email: '' });
                                      }}
                                      className="text-[11px] text-[#171717] underline hover:no-underline font-medium"
                                    >
                                      + Provision First Admin
                                    </button>
                                  </div>
                                ) : (
                                  org.admins.map((u) => (
                                    <div
                                      key={u.id}
                                      className="flex flex-wrap items-center justify-between gap-2 p-2 bg-[#FAFAF8] border border-[#E5E5E0] rounded text-[12px] hover:bg-white hover:border-[#171717]/30 transition-colors"
                                    >
                                      <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-[#171717]" />
                                        <span className="font-semibold text-[#171717]">{u.username}</span>
                                        {u.displayName && u.displayName !== u.username && (
                                          <span className="text-[11px] text-[#737373]">({u.displayName})</span>
                                        )}
                                        {u.email && (
                                          <span className="text-[11px] text-[#737373]">· {u.email}</span>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20 px-1.5 py-0.2 rounded font-semibold">
                                          {u.status}
                                        </span>
                                        <span className="text-[10px] font-mono text-[#737373] bg-white border border-[#E5E5E0] px-1.5 py-0.5 rounded font-semibold">
                                          {u.role}
                                        </span>
                                        <button
                                          onClick={() => {
                                            setTargetAdminForReset({
                                              id: u.id,
                                              username: u.username,
                                              displayName: u.displayName,
                                              email: u.email,
                                              orgName: org.name,
                                              orgCode: org.code,
                                            });
                                            setResetResult(null);
                                            setShowEmergencyResetModal(true);
                                          }}
                                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-white hover:bg-[#FAFAF8] text-[#B35900] hover:text-[#904700] border border-[#E5E5E0] text-[11px] font-semibold transition-colors shadow-2xs"
                                          title={`Trigger emergency credential reset for ${u.username}`}
                                        >
                                          <KeyRound className="w-3 h-3 text-[#B35900]" />
                                          <span>Emergency Reset</span>
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Directory Table View */}
        {tab === 'DIRECTORY' && (
          <div className="border border-[#E5E5E0] rounded-lg bg-white shadow-xs overflow-hidden">
            <div className="p-4 border-b border-[#E5E5E0] bg-white">
              <h2 className="text-[16px] font-semibold text-[#171717] flex items-center gap-2">
                <Globe className="w-4 h-4 text-[#171717]" /> Managed Organisations Directory
              </h2>
              <p className="text-[12px] text-[#737373] mt-0.5">
                Every organisation has strict data isolation and cannot view or access peer tenant resources.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[#737373] text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="p-3 font-semibold">Organisation</th>
                    <th className="p-3 font-semibold">Code</th>
                    <th className="p-3 font-semibold">Timezone & Currency</th>
                    <th className="p-3 font-semibold">Workspaces</th>
                    <th className="p-3 font-semibold">Users</th>
                    <th className="p-3 font-semibold">Created</th>
                    <th className="p-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E5E0] text-[#171717]">
                  {filteredOrgs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-[#737373]">
                        No organisations match your search query.
                      </td>
                    </tr>
                  ) : (
                    filteredOrgs.map((org) => {
                      const wsCount = org.workspaceCount ?? org.workspace_count ?? 0;
                      const uCount = org.userCount ?? org.user_count ?? 0;
                      const legal = org.legalName || org.legal_name;
                      return (
                        <tr key={org.id} className="hover:bg-[#FAFAF8] transition-colors">
                          <td className="p-3">
                            <div className="font-semibold text-[#171717]">{org.name}</div>
                            {legal && legal !== org.name && (
                              <div className="text-[11px] text-[#737373]">{legal}</div>
                            )}
                          </td>
                          <td className="p-3 font-mono font-bold text-[#171717]">{org.code}</td>
                          <td className="p-3 text-[#737373]">
                            {org.timezone} · {org.currency}
                          </td>
                          <td className="p-3">
                            <button
                              onClick={() => openWorkspacesModal(org)}
                              className="font-medium text-[#2F7D5A] hover:underline flex items-center gap-1"
                            >
                              <Building2 className="w-3.5 h-3.5" />
                              <span>{wsCount} workspace{wsCount !== 1 ? 's' : ''}</span>
                            </button>
                          </td>
                          <td className="p-3 text-[#171717] font-mono">{uCount}</td>
                          <td className="p-3 text-[#737373]">
                            {org.createdAt || org.created_at ? new Date(org.createdAt || org.created_at!).toLocaleDateString() : '-'}
                          </td>
                          <td className="p-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                onClick={() => openWorkspacesModal(org)}
                                className="px-2.5 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[12px] font-medium transition-colors"
                              >
                                Workspaces
                              </button>
                              <button
                                onClick={() => {
                                  setSelectedOrgForAdmin(org);
                                  setNewAdminForm({ username: 'admin', password: '', displayName: 'Administrator', email: '' });
                                }}
                                className="px-2.5 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[12px] font-medium transition-colors"
                              >
                                + Admin
                              </button>
                              {(() => {
                                const existingLic = licenses.find((l) => l.tenantId === org.id && l.status !== 'CANCELLED');
                                return (
                                  <button
                                    onClick={() => existingLic ? openEditLicenseModal(existingLic) : openIssueLicenseModal(org.id)}
                                    className="px-2.5 py-1 bg-white hover:bg-[#FAFAF8] text-[#171717] rounded border border-[#E5E5E0] text-[12px] font-medium transition-colors"
                                    title={existingLic ? "Configure active license for this organisation" : "Issue new commercial license for this organisation"}
                                  >
                                    License
                                  </button>
                                );
                              })()}
                              <button
                                onClick={() => openEditOrgModal(org)}
                                className="p-1.5 bg-white hover:bg-[#FAFAF8] text-[#737373] hover:text-[#171717] rounded border border-[#E5E5E0] text-[12px] transition-colors"
                                title="Edit settings"
                              >
                                <Edit2 className="w-3.5 h-3.5 inline" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: Cross-Tenant Analytics & Capacity Telemetry */}
        {tab === 'ANALYTICS' && (
          <div className="space-y-6">
            {/* Telemetry Charts: Seat Allocation & Operational Footprint */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Chart 1: Seat Capacity & Personnel Allocation */}
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#171717] flex items-center gap-2">
                      <Users className="w-4 h-4 text-[#171717]" /> Cross-Tenant Seat & Roster Allocation
                    </h3>
                    <p className="text-[12px] text-[#737373]">
                      Active user seats vs total provisioned users and employee roster counts per tenant.
                    </p>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-[#E5E5E0] bg-[#FAFAF8] text-[#737373]">
                    Per Organisation
                  </span>
                </div>

                <div className="h-64 w-full pt-2">
                  {analyticsData && analyticsData.tenants.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={analyticsData.tenants.map((t) => ({
                          name: t.code,
                          fullName: t.displayName || t.name,
                          'Active Users': t.activeUserCount,
                          'Total Users': t.userCount,
                          'Employees': t.employeeCount,
                          'Workspaces': t.workspaceCount,
                        }))}
                        margin={{ top: 10, right: 10, left: -20, bottom: 20 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0ED" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#737373' }} axisLine={{ stroke: '#E5E5E0' }} />
                        <YAxis tick={{ fontSize: 11, fill: '#737373' }} axisLine={{ stroke: '#E5E5E0' }} allowDecimals={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} />
                        <Bar dataKey="Active Users" fill="#2F7D5A" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Total Users" fill="#171717" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Employees" fill="#4F6F8F" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Workspaces" fill="#D4D4D0" radius={[3, 3, 0, 0]} maxBarSize={32} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#737373]">
                      No tenant telemetry data available.
                    </div>
                  )}
                </div>
              </div>

              {/* Chart 2: Operational Workload & Ingestion Volume */}
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#171717] flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-[#171717]" /> Operational Workload & Rostering Load
                    </h3>
                    <p className="text-[12px] text-[#737373]">
                      Generated schedules, forecast versions, and audit operations across tenant spaces.
                    </p>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-[#E5E5E0] bg-[#FAFAF8] text-[#737373]">
                    Workload Volume
                  </span>
                </div>

                <div className="h-64 w-full pt-2">
                  {analyticsData && analyticsData.tenants.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={analyticsData.tenants.map((t) => ({
                          name: t.code,
                          fullName: t.displayName || t.name,
                          'Schedules': t.scheduleCount,
                          'Published': t.publishedScheduleCount,
                          'Forecasts': t.forecastCount,
                          'Audit Events': t.auditCount,
                        }))}
                        margin={{ top: 10, right: 10, left: -20, bottom: 20 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0ED" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#737373' }} axisLine={{ stroke: '#E5E5E0' }} />
                        <YAxis tick={{ fontSize: 11, fill: '#737373' }} axisLine={{ stroke: '#E5E5E0' }} allowDecimals={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} />
                        <Bar dataKey="Schedules" fill="#171717" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Published" fill="#2F7D5A" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Forecasts" fill="#7A62A8" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        <Bar dataKey="Audit Events" fill="#4F6F8F" radius={[3, 3, 0, 0]} maxBarSize={32} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#737373]">
                      No tenant workload data available.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Storage & Record Distribution Telemetry */}
            <div className="bg-white border border-[#E5E5E0] rounded-lg p-5 shadow-xs space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E5E0] pb-3">
                <div>
                  <h3 className="text-[14px] font-bold text-[#171717] flex items-center gap-2">
                    <Database className="w-4 h-4 text-[#171717]" /> Platform Database Storage & Record Volume Telemetry
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    Active record counts across core multi-tenant schema tables.
                  </p>
                </div>
                <div className="text-[12px] font-mono text-[#737373]">
                  PostgreSQL <span className="font-semibold text-[#171717]">wfm</span> schema
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5 pt-1">
                {(analyticsData?.storageDistribution || []).map((item, idx) => {
                  const totalRecords = (analyticsData?.storageDistribution || []).reduce((acc, i) => acc + i.records, 0) || 1;
                  const pct = Math.round((item.records / totalRecords) * 100);
                  return (
                    <div key={idx} className="p-3 rounded-lg border border-[#E5E5E0] bg-[#FAFAF8] space-y-1.5">
                      <div className="text-[11px] font-semibold text-[#737373] truncate">{item.name}</div>
                      <div className="text-[18px] font-bold tabular-nums font-mono text-[#171717]">
                        {item.records.toLocaleString()}
                      </div>
                      <div className="w-full bg-[#E5E5E0] h-1.5 rounded-full overflow-hidden">
                        <div className="bg-[#171717] h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
                      </div>
                      <div className="text-[10px] text-[#737373] flex justify-between">
                        <span>{item.category}</span>
                        <span className="font-mono">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Capacity Telemetry Matrix Table */}
            <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#E5E5E0] bg-white flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-bold text-[#171717] flex items-center gap-2">
                    <BarChart2 className="w-4 h-4 text-[#171717]" /> Cross-Tenant Capacity Matrix
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    Real-time capacity utilization, operational workloads, and activity scoring across all tenant boundaries.
                  </p>
                </div>

                {/* Tier filter buttons */}
                <div className="flex items-center gap-1.5 bg-[#FAFAF8] p-1 rounded border border-[#E5E5E0] text-[11px]">
                  <span className="text-[#737373] px-2 font-medium">Activity:</span>
                  {(['ALL', 'HIGH_ACTIVITY', 'MODERATE', 'IDLE'] as const).map((tier) => (
                    <button
                      key={tier}
                      onClick={() => setAnalyticsFilter(tier)}
                      className={`px-2.5 py-1 rounded font-medium transition-colors ${
                        analyticsFilter === tier
                          ? 'bg-white text-[#171717] shadow-xs border border-[#E5E5E0] font-semibold'
                          : 'text-[#737373] hover:text-[#171717]'
                      }`}
                    >
                      {tier === 'ALL' ? 'All' : tier === 'HIGH_ACTIVITY' ? 'High Activity' : tier === 'MODERATE' ? 'Moderate' : 'Idle'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-[#E5E5E0] bg-[#FAFAF8] text-[#737373] font-semibold text-[11px] uppercase tracking-wider">
                      <th className="py-3 px-4">Organisation</th>
                      <th className="py-3 px-3">Workspaces</th>
                      <th className="py-3 px-3">Seat Utilization</th>
                      <th className="py-3 px-3">Employees</th>
                      <th className="py-3 px-3">Schedules</th>
                      <th className="py-3 px-3">Forecasts</th>
                      <th className="py-3 px-3">Ingested Rows</th>
                      <th className="py-3 px-3">Last Active</th>
                      <th className="py-3 px-3">Adoption Tier</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0]">
                    {filteredTelemetryTenants.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-8 text-center text-[#737373] text-[13px]">
                          No tenants match the current telemetry filter or search query.
                        </td>
                      </tr>
                    ) : (
                      filteredTelemetryTenants.map((t) => {
                        const userPct = t.userCount > 0 ? Math.round((t.activeUserCount / t.userCount) * 100) : 0;
                        return (
                          <tr key={t.id} className="hover:bg-[#FAFAF8] transition-colors">
                            <td className="py-3 px-4">
                              <div className="font-semibold text-[#171717]">{t.displayName || t.name}</div>
                              <div className="text-[11px] text-[#737373] flex items-center gap-1.5 mt-0.5">
                                <span className="font-mono bg-[#F0F0ED] px-1 rounded text-[#525252] font-semibold">{t.code}</span>
                                <span>·</span>
                                <span>{t.timezone}</span>
                                <span>·</span>
                                <span>{t.currency}</span>
                              </div>
                            </td>

                            <td className="py-3 px-3">
                              <span className="font-mono font-semibold text-[#171717]">{t.workspaceCount}</span>
                              <span className="text-[11px] text-[#737373] ml-1">ws</span>
                            </td>

                            <td className="py-3 px-3">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-[#171717]">{t.activeUserCount}</span>
                                <span className="text-[11px] text-[#737373]">/ {t.userCount}</span>
                              </div>
                              <div className="w-20 bg-[#E5E5E0] h-1.5 rounded-full overflow-hidden mt-1">
                                <div className="bg-[#2F7D5A] h-full rounded-full" style={{ width: `${userPct}%` }} />
                              </div>
                            </td>

                            <td className="py-3 px-3">
                              <span className="font-mono text-[#171717] font-semibold">{t.employeeCount}</span>
                            </td>

                            <td className="py-3 px-3">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-semibold text-[#171717]">{t.scheduleCount}</span>
                                {t.publishedScheduleCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded font-semibold bg-[#EAF5EF] text-[#2F7D5A] border border-[#2F7D5A]/20">
                            {t.publishedScheduleCount} pub
                          </span>
                                )}
                              </div>
                            </td>

                            <td className="py-3 px-3">
                              <span className="font-mono text-[#171717]">{t.forecastCount}</span>
                            </td>

                            <td className="py-3 px-3 font-mono text-[12px] text-[#171717]">
                              {t.intervalCount.toLocaleString()}
                            </td>

                            <td className="py-3 px-3 text-[12px] text-[#737373]">
                              <span title={t.lastActiveAt}>{timeAgo(t.lastActiveAt)}</span>
                            </td>

                            <td className="py-3 px-3">
                              {t.statusTier === 'HIGH_ACTIVITY' ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded border bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#2F7D5A]" />
                                  Active & Scaling
                                </span>
                              ) : t.statusTier === 'MODERATE' ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded border bg-[#EDF3F8] text-[#4F6F8F] border-[#4F6F8F]/20">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#4F6F8F]" />
                                  Steady Load
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border bg-[#F5F5F2] text-[#737373] border-[#E5E5E0]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#A3A39E]" />
                                  Provisioned / Idle
                                </span>
                              )}
                            </td>

                            <td className="py-3 px-4 text-right">
                              <button
                                onClick={() => {
                                  setSearch(t.code);
                                  setTab('TREE');
                                }}
                                className="text-[12px] text-[#171717] hover:underline font-semibold flex items-center gap-1 ml-auto"
                              >
                                <span>View Tree</span>
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Live Cross-Tenant Audit Ledger Stream */}
            <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#E5E5E0] bg-white flex items-center justify-between">
                <div>
                  <h3 className="text-[15px] font-bold text-[#171717] flex items-center gap-2">
                    <Radio className="w-4 h-4 text-[#2F7D5A] animate-pulse" /> Live Cross-Tenant Audit & Event Ledger
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    Real-time feed of the latest transactions and administrator actions across all organizations.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      platformApi<PlatformAnalyticsData>('/analytics')
                        .then((data) => setAnalyticsData(data))
                        .catch(() => {});
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] text-[11px] font-semibold transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh Feed
                  </button>
                </div>
              </div>

              <div className="divide-y divide-[#E5E5E0] max-h-80 overflow-y-auto">
                {(analyticsData?.recentAudit || []).length === 0 ? (
                  <div className="p-6 text-center text-[#737373] text-[13px]">
                    No recent audit events recorded.
                  </div>
                ) : (
                  (analyticsData?.recentAudit || []).map((audit) => (
                    <div key={audit.id} className="p-3.5 hover:bg-[#FAFAF8] transition-colors flex items-center justify-between gap-4 text-[12px]">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-[10px] text-[#737373] shrink-0 w-16">
                          {timeAgo(audit.at)}
                        </span>
                        <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[#F0F0ED] text-[#171717] shrink-0">
                          {audit.tenantCode || audit.tenantName}
                        </span>
                        <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded border border-[#E5E5E0] bg-white shrink-0 text-[#171717]">
                          {audit.action}
                        </span>
                        <div className="truncate text-[#171717]">
                          <span className="font-medium text-[#737373]">{audit.entityType}:</span>{' '}
                          <span className="font-semibold">{audit.entityName || '(system)'}</span>
                          {audit.diffSummary && (
                            <span className="text-[#737373] text-[11px] ml-2">({audit.diffSummary})</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 text-[11px] text-[#737373]">
                        <span className="hidden sm:inline">By <strong className="text-[#171717]">{audit.actorName}</strong> ({audit.actorRole})</span>
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-[#FAFAF8] border border-[#E5E5E0]">
                          {audit.source}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: Global Platform Audit Trail & Security */}
        {tab === 'SECURITY' && (
          <div className="space-y-6">
            {/* Active & Recent Emergency Resets Ledger */}
            <div className="border border-[#E5E5E0] rounded-lg bg-white shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#E5E5E0] bg-[#FAFAF8] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-bold text-[#171717] flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-[#B35900]" />
                    <span>Emergency Credential Resets & Access Recovery Ledger</span>
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    Recent high-entropy recovery credentials and secure one-time reset links generated by Super Admins for locked-out organisation administrators.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono text-[#737373] text-[11px]">
                    {emergencyResetsLedger.filter((r) => (r.token_status || (r as any).tokenStatus) === 'ACTIVE').length} active token{emergencyResetsLedger.filter((r) => (r.token_status || (r as any).tokenStatus) === 'ACTIVE').length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {emergencyResetsLedger.length === 0 ? (
                <div className="p-8 text-center text-[#737373] text-[13px] bg-white">
                  <ShieldCheck className="w-8 h-8 text-[#2F7D5A] mx-auto mb-2 opacity-60" />
                  <div className="font-semibold text-[#171717]">No Emergency Resets on Record</div>
                  <div className="text-[12px] text-[#737373] mt-1">
                    Super Admins can trigger instant credential resets from the Multi-Tenant Hierarchy Tree whenever an organisation administrator is locked out.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[#737373] text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="p-3 font-semibold">Target Administrator</th>
                        <th className="p-3 font-semibold">Organisation</th>
                        <th className="p-3 font-semibold">Issued By</th>
                        <th className="p-3 font-semibold">Credential Hint</th>
                        <th className="p-3 font-semibold">Issued At</th>
                        <th className="p-3 font-semibold">Status / Expiry</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E5E5E0]">
                      {emergencyResetsLedger.map((r) => {
                        const status = r.token_status || (r as any).tokenStatus;
                        const targetUser = (r as any).username || r.target_username || (r as any).targetUsername || r.user_id || (r as any).userId;
                        const tenantName = r.tenant_name || (r as any).tenantName || 'Unknown Org';
                        const tenantCode = r.tenant_code || (r as any).tenantCode;
                        const createdBy = r.created_by_admin_email || (r as any).createdByAdminEmail || 'Super Admin';
                        const hint = r.temp_password_hint || (r as any).tempPasswordHint || 'One-Time Token';
                        const createdAt = r.created_at || (r as any).createdAt;
                        const expiresAt = r.expires_at || (r as any).expiresAt;

                        return (
                          <tr key={r.id} className="hover:bg-[#FAFAF8] transition-colors">
                            <td className="p-3 font-semibold text-[#171717]">
                              <div className="flex items-center gap-1.5">
                                <Key className="w-3.5 h-3.5 text-[#171717]" />
                                <span>{targetUser}</span>
                              </div>
                            </td>
                            <td className="p-3">
                              <span className="font-semibold text-[#171717]">{tenantName}</span>
                              {tenantCode && (
                                <span className="ml-1.5 font-mono text-[10px] px-1.5 py-0.2 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                                  {tenantCode}
                                </span>
                              )}
                            </td>
                            <td className="p-3 font-mono text-[#737373] text-[11px]">
                              {createdBy}
                            </td>
                            <td className="p-3 font-mono text-[11px] text-[#171717]">
                              <span className="px-1.5 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0]">
                                {hint}
                              </span>
                            </td>
                            <td className="p-3 text-[#737373] text-[11px] whitespace-nowrap">
                              {createdAt ? new Date(createdAt).toLocaleString() : '—'}
                            </td>
                            <td className="p-3">
                              {status === 'ACTIVE' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#FFF8EB] border border-[#B35900]/30 text-[#B35900] font-bold text-[10px]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#B35900] animate-pulse" />
                                  ACTIVE · PENDING USE
                                </span>
                              ) : status === 'USED' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#EAF5EF] border border-[#2F7D5A]/30 text-[#2F7D5A] font-semibold text-[10px]">
                                  <CheckCircle2 className="w-3 h-3" />
                                  COMPLETED / USED
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373] font-medium text-[10px]">
                                  EXPIRED
                                </span>
                              )}
                              <div className="text-[10px] text-[#737373] mt-0.5">
                                Expires {expiresAt ? new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Root Platform Audit Trail */}
            <div className="border border-[#E5E5E0] rounded-lg bg-white shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#E5E5E0] bg-[#FAFAF8] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-bold text-[#171717] flex items-center gap-2">
                    <ScrollText className="w-4 h-4 text-[#171717]" />
                    <span>Immutable Platform Root Audit Trail</span>
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    Cross-organization event log tracking administrative sign-ins, IP addresses, tenant creations, workspaces, and emergency resets.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#737373] bg-white border border-[#E5E5E0] px-2 py-1 rounded font-mono">
                    Showing <strong>{(auditData?.items || (auditData as any)?.logs || []).length}</strong> of <strong>{auditData?.stats?.totalEvents ?? 0}</strong> events
                  </span>
                </div>
              </div>

              {/* Action Filter Pills */}
              <div className="p-3 bg-white border-b border-[#E5E5E0] flex items-center gap-2 overflow-x-auto text-[11px]">
                <span className="text-[#737373] font-semibold uppercase text-[10px] tracking-wider shrink-0 mr-1">
                  Quick Filter:
                </span>
                {[
                  { label: 'All Events', value: '' },
                  { label: 'Sign-Ins', value: 'SIGN_IN' },
                  { label: 'Failed Logins', value: 'SIGN_IN_FAILED' },
                  { label: 'Org Provisioning', value: 'PROVISION_ORGANISATION' },
                  { label: 'Workspaces', value: 'CREATE_WORKSPACE' },
                  { label: 'Admins', value: 'PROVISION_ADMIN' },
                  { label: 'Emergency Resets', value: 'EMERGENCY_CREDENTIAL_RESET' },
                ].map((f) => (
                  <button
                    key={f.value}
                    onClick={() => {
                      setAuditActionFilter(f.value);
                      fetchAuditLogs(search, f.value, auditTenantFilter);
                    }}
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium transition-colors shrink-0 ${
                      auditActionFilter === f.value
                        ? 'bg-[#171717] text-white border-[#171717]'
                        : 'bg-white text-[#737373] hover:text-[#171717] border-[#E5E5E0] hover:bg-[#FAFAF8]'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {!(auditData?.items || (auditData as any)?.logs)?.length ? (
                <div className="p-12 text-center text-[#737373] text-[13px] bg-white">
                  <ShieldCheck className="w-8 h-8 text-[#737373] mx-auto mb-2 opacity-50" />
                  <div className="font-semibold text-[#171717]">No Audit Records Found</div>
                  <div className="text-[12px] text-[#737373] mt-1">
                    No platform operations match your current search and action filters.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[#737373] text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="p-3 font-semibold">Timestamp</th>
                        <th className="p-3 font-semibold">Action</th>
                        <th className="p-3 font-semibold">Actor / IP Address</th>
                        <th className="p-3 font-semibold">Target Tenant</th>
                        <th className="p-3 font-semibold">Target Entity</th>
                        <th className="p-3 font-semibold">Details</th>
                        <th className="p-3 font-semibold text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E5E5E0]">
                      {(auditData?.items || (auditData as any)?.logs || []).map((log: PlatformAuditItem) => {
                        const adminEmail = log.adminEmail || (log as any).admin_email || 'System';
                        const ipAddr = log.ipAddress || (log as any).ip_address || '—';
                        const tenantName = log.targetTenantName || (log as any).target_tenant_name;
                        const tenantCode = log.targetTenantCode || (log as any).target_tenant_code;
                        const entityType = log.targetEntityType || (log as any).target_entity_type;
                        const entityName = log.targetEntityName || (log as any).target_entity_name;
                        const action = log.action;
                        const status = log.status || 'SUCCESS';
                        const details = log.details || {};

                        // Badge styling by action category
                        let actionBadgeClass = 'bg-[#FAFAF8] text-[#171717] border-[#E5E5E0]';
                        if (action === 'SIGN_IN' || action === 'SIGN_OUT') {
                          actionBadgeClass = 'bg-[#EDF3F8] text-[#4F6F8F] border-[#4F6F8F]/30';
                        } else if (action === 'SIGN_IN_FAILED') {
                          actionBadgeClass = 'bg-[#FDF0EE] text-[#C93B2B] border-[#C93B2B]/30';
                        } else if (action === 'PROVISION_ORGANIZATION' || action === 'CREATE_WORKSPACE') {
                          actionBadgeClass = 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/30';
                        } else if (action === 'PROVISION_ADMIN') {
                          actionBadgeClass = 'bg-[#F4EFFB] text-[#7A62A8] border-[#7A62A8]/30';
                        } else if (action === 'EMERGENCY_CREDENTIAL_RESET') {
                          actionBadgeClass = 'bg-[#FFF8EB] text-[#B35900] border-[#B35900]/30';
                        } else if (action === 'EMERGENCY_RESET_COMPLETED') {
                          actionBadgeClass = 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/30';
                        }

                        // Format details summary string
                        let detailSummary = details.description || '';
                        if (!detailSummary) {
                          if (action === 'SIGN_IN') detailSummary = 'Super Admin authenticated via platform portal';
                          else if (action === 'SIGN_IN_FAILED') detailSummary = `Failed credentials attempt: ${details.email || ''}`;
                          else if (action === 'SIGN_OUT') detailSummary = 'Admin signed out of platform session';
                          else if (action === 'EMERGENCY_CREDENTIAL_RESET') detailSummary = `Generated ${details.method || 'credentials'} for admin: ${details.targetUsername || ''}`;
                          else if (action === 'EMERGENCY_RESET_COMPLETED') detailSummary = 'User redeemed reset token and updated permanent password';
                          else if (action === 'CREATE_WORKSPACE') detailSummary = `Created workspace '${details.name || ''}' [${details.code || ''}]`;
                          else if (action === 'PROVISION_ORGANIZATION') detailSummary = `Created organization '${details.name || ''}' [${details.code || ''}]`;
                          else if (action === 'PROVISION_ADMIN') detailSummary = `Created administrator '${details.username || ''}'`;
                          else detailSummary = Object.keys(details).length ? JSON.stringify(details) : '—';
                        }

                        return (
                          <tr key={log.id} className="hover:bg-[#FAFAF8] transition-colors">
                            <td className="p-3 text-[#737373] font-mono text-[11px] whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <Clock className="w-3 h-3 text-[#737373]" />
                                <span>{new Date(log.at).toLocaleString()}</span>
                              </div>
                            </td>

                            <td className="p-3">
                              <span className={`inline-block px-2 py-0.5 rounded font-mono font-bold text-[10px] border ${actionBadgeClass}`}>
                                {action}
                              </span>
                            </td>

                            <td className="p-3">
                              <div className="font-semibold text-[#171717]">{adminEmail}</div>
                              <div className="font-mono text-[10px] text-[#737373] mt-0.5 flex items-center gap-1">
                                <span>IP:</span>
                                <span className="bg-[#FAFAF8] px-1 py-0.2 rounded border border-[#E5E5E0]">{ipAddr}</span>
                              </div>
                            </td>

                            <td className="p-3">
                              {tenantName ? (
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-semibold text-[#171717]">{tenantName}</span>
                                  {tenantCode && (
                                    <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-[#FAFAF8] border border-[#E5E5E0] text-[#737373]">
                                      {tenantCode}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[#737373] text-[11px] italic">Global Platform</span>
                              )}
                            </td>

                            <td className="p-3 text-[11px]">
                              {entityType ? (
                                <div>
                                  <span className="font-medium text-[#737373]">{entityType}:</span>{' '}
                                  <span className="font-semibold text-[#171717]">{entityName || '—'}</span>
                                </div>
                              ) : (
                                <span className="text-[#737373]">—</span>
                              )}
                            </td>

                            <td className="p-3 text-[11px] text-[#171717] max-w-xs truncate" title={detailSummary}>
                              {detailSummary}
                            </td>

                            <td className="p-3 text-right whitespace-nowrap">
                              {status === 'SUCCESS' ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#2F7D5A] bg-[#EAF5EF] border border-[#2F7D5A]/30 px-2 py-0.5 rounded">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#2F7D5A]" />
                                  SUCCESS
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#C93B2B] bg-[#FDF0EE] border border-[#C93B2B]/30 px-2 py-0.5 rounded">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#C93B2B]" />
                                  FAILURE
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* =========================================================================
            LICENSING & ENTITLEMENTS VIEW
        ========================================================================= */}
        {tab === 'LICENSING' && (
          <div className="space-y-6 animate-in fade-in">
            {/* Pending Capacity Requests */}
            {capacityRequests.filter((r: any) => r.status === 'PENDING').length > 0 && (
              <div className="bg-white border border-[#E5E5E0] rounded-lg p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-2.5 w-2.5 rounded-full bg-[#DC2626] animate-pulse" />
                    <h3 className="font-bold text-[15px] text-[#171717]">Pending Capacity Upgrade Requests</h3>
                  </div>
                  <span className="text-[11px] font-semibold text-[#DC2626] bg-[#FEF2F2] border border-[#FCA5A5] px-2 py-0.5 rounded-full">
                    {capacityRequests.filter((r: any) => r.status === 'PENDING').length} Action Required
                  </span>
                </div>

                <div className="divide-y divide-[#E5E5E0]">
                  {capacityRequests
                    .filter((r: any) => r.status === 'PENDING')
                    .map((r: any) => (
                      <div key={r.id} className="py-3 flex flex-wrap items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[14px] text-[#171717]">{r.tenantName}</span>
                            <span className="font-mono text-[11px] text-[#737373]">({r.tenantCode})</span>
                            <span className="text-[11px] px-2 py-0.5 rounded bg-[#FAFAF8] border border-[#E5E5E0] font-semibold">
                              {r.resourceType}
                            </span>
                          </div>
                          <div className="text-[12px] text-[#525252]">
                            Requested <b>+{r.additionalNeeded} seats</b> (Current: {r.currentCapacity} → Target: {r.requestedCapacity}) by <b>{r.requesterName}</b> ({r.requesterEmail})
                          </div>
                          {r.justification && (
                            <div className="text-[11px] text-[#737373] italic">
                              "{r.justification}"
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleDecideRequest(r.id, 'APPROVE')}
                            disabled={busy}
                            className="px-3 py-1.5 bg-[#171717] hover:bg-[#333333] text-white rounded text-xs font-semibold flex items-center gap-1.5 transition-colors"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-[#2F7D5A]" /> Approve & Grant
                          </button>
                          <button
                            onClick={() => handleDecideRequest(r.id, 'REJECT')}
                            disabled={busy}
                            className="px-3 py-1.5 bg-white hover:bg-[#FAFAF8] text-[#DC2626] border border-[#E5E5E0] rounded text-xs font-semibold transition-colors"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* All Issued Tenant Licenses Table */}
            <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-xs overflow-hidden">
              <div className="p-4 border-b border-[#E5E5E0] flex items-center justify-between bg-[#FAFAF8]">
                <div>
                  <h3 className="font-bold text-[15px] text-[#171717] flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-[#171717]" /> Commercial Tenant Licenses ({licenses.length})
                  </h3>
                  <p className="text-[12px] text-[#737373] mt-0.5">
                    First-class enforceable license objects and capacity limits across all isolated customer boundaries.
                  </p>
                </div>

                <button
                  onClick={() => openIssueLicenseModal()}
                  className="px-3 py-1.5 bg-[#171717] hover:bg-[#333333] text-white rounded text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" /> Issue License to Organisation
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Customer / Tenant</th>
                      <th className="py-3 px-4">License Key</th>
                      <th className="py-3 px-4">Plan & Edition</th>
                      <th className="py-3 px-4">Employee Capacity</th>
                      <th className="py-3 px-4">Named Users</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Valid Until</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0]">
                    {licenses.map((lic: any) => {
                      const empPercent = lic.maxEmployees > 0
                        ? Math.round(((lic.activeEmployees || 0) / lic.maxEmployees) * 100)
                        : 0;
                      const userPercent = lic.maxUsers > 0
                        ? Math.round(((lic.activeUsers || 0) / lic.maxUsers) * 100)
                        : 0;

                      return (
                        <tr key={lic.id} className="hover:bg-[#FAFAF8] transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-bold text-[13px] text-[#171717]">{lic.tenantName}</div>
                            <div className="font-mono text-[11px] text-[#737373]">{lic.tenantCode}</div>
                          </td>

                          <td className="py-3 px-4 font-mono text-[12px] text-[#525252]">
                            {lic.licenseKey}
                          </td>

                          <td className="py-3 px-4">
                            <span className="font-semibold text-[12px] text-[#171717]">{lic.planTier}</span>
                            <div className="text-[10px] text-[#737373]">{lic.edition}</div>
                          </td>

                          <td className="py-3 px-4 min-w-44">
                            <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                              <span>{lic.activeEmployees || 0} / {lic.maxEmployees}</span>
                              <span className={empPercent >= 100 ? 'text-[#DC2626] font-bold' : 'text-[#737373]'}>
                                {empPercent}%
                              </span>
                            </div>
                            <div className="w-full bg-[#E5E5E0] h-1.5 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${empPercent >= 100 ? 'bg-[#DC2626]' : empPercent >= 85 ? 'bg-[#F59E0B]' : 'bg-[#171717]'}`}
                                style={{ width: `${Math.min(100, empPercent)}%` }}
                              />
                            </div>
                          </td>

                          <td className="py-3 px-4 min-w-36">
                            <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                              <span>{lic.activeUsers || 0} / {lic.maxUsers}</span>
                              <span className="text-[#737373]">{userPercent}%</span>
                            </div>
                            <div className="w-full bg-[#E5E5E0] h-1.5 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[#525252]"
                                style={{ width: `${Math.min(100, userPercent)}%` }}
                              />
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            <span
                              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                lic.status === 'ACTIVE'
                                  ? 'bg-[#DCFCE7] text-[#15803D]'
                                  : lic.status === 'GRACE_PERIOD'
                                  ? 'bg-[#FEF3C7] text-[#B45309]'
                                  : lic.status === 'SUSPENDED'
                                  ? 'bg-[#FEE2E2] text-[#B91C1C]'
                                  : 'bg-[#F5F5F5] text-[#737373]'
                              }`}
                            >
                              {lic.status}
                            </span>
                          </td>

                          <td className="py-3 px-4 text-[#737373] whitespace-nowrap">
                            <div>{lic.endDate ? new Date(lic.endDate).toLocaleDateString() : '—'}</div>
                            <div className="text-[10px]">{lic.gracePeriodDays}d grace period</div>
                          </td>

                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => openEditLicenseModal(lic)}
                              className="px-2.5 py-1 text-[11px] font-semibold rounded border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] transition-colors shadow-xs"
                            >
                              Configure License
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        </main>
      </div>

      {/* Modal: Provision New Organisation (Clean White Theme) */}
      {showNewOrg && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#171717]" /> Provision New Organisation
              </h3>
              <button onClick={() => setShowNewOrg(false)} className="text-[#737373] hover:text-[#171717] text-sm">✕</button>
            </div>

            {createdOrgSummary ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#EAF5EF] border border-[#2F7D5A]/20 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-[#2F7D5A] font-bold text-sm">
                    <CheckCircle2 className="w-4 h-4" /> Organisation Provisioned Successfully!
                  </div>
                  <p className="text-[12px] text-[#171717]">
                    The tenant boundary and default workspace have been initialized. Share these initial credentials with the organisation owner:
                  </p>
                  <div className="bg-white p-3 rounded border border-[#E5E5E0] font-mono text-xs space-y-1 text-[#171717]">
                    <div><strong>Organisation:</strong> {createdOrgSummary.org.name} ({createdOrgSummary.org.code})</div>
                    <div><strong>Default Workspace:</strong> {createdOrgSummary.workspace?.name || 'Default'}</div>
                    {createdOrgSummary.adminUser && (
                      <>
                        <div><strong>Admin Username:</strong> {createdOrgSummary.adminUser}</div>
                        <div><strong>Admin Password:</strong> {createdOrgSummary.adminPassword}</div>
                      </>
                    )}
                  </div>
                  {createdOrgSummary.adminUser && (
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `Organisation: ${createdOrgSummary.org.name} (${createdOrgSummary.org.code})\nUsername: ${createdOrgSummary.adminUser}\nPassword: ${createdOrgSummary.adminPassword}`
                        );
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="px-3 py-1.5 bg-white hover:bg-[#FAFAF8] text-xs font-semibold text-[#171717] rounded border border-[#E5E5E0] flex items-center gap-1.5 shadow-xs"
                    >
                      <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied to Clipboard!' : 'Copy Credentials'}
                    </button>
                  )}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setCreatedOrgSummary(null);
                      setShowNewOrg(false);
                    }}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white font-semibold text-xs rounded transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateOrg} className="space-y-3 text-xs">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                    Organisation Name <span className="text-[#DC2626]">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Acme Corporation"
                    value={newOrgForm.name}
                    onChange={(e) => setNewOrgForm({ ...newOrgForm, name: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                      Code (Unique) <span className="text-[#DC2626]">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={10}
                      placeholder="ACME"
                      value={newOrgForm.code}
                      onChange={(e) => setNewOrgForm({ ...newOrgForm, code: e.target.value.toUpperCase() })}
                      className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono uppercase focus:outline-none focus:border-[#171717]"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1">Legal Entity Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Acme Global Inc."
                      value={newOrgForm.legalName}
                      onChange={(e) => setNewOrgForm({ ...newOrgForm, legalName: e.target.value })}
                      className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1">Timezone</label>
                    <select
                      value={newOrgForm.timezone}
                      onChange={(e) => setNewOrgForm({ ...newOrgForm, timezone: e.target.value })}
                      className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                    >
                      {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-[#171717] mb-1">Currency</label>
                    <select
                      value={newOrgForm.currency}
                      onChange={(e) => setNewOrgForm({ ...newOrgForm, currency: e.target.value })}
                      className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                    >
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                <div className="p-3.5 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] space-y-2 mt-2">
                  <span className="block text-[11px] font-bold uppercase text-[#171717] tracking-wider">
                    First Organisation Administrator
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Admin Username</label>
                      <input
                        type="text"
                        value={newOrgForm.adminUser}
                        onChange={(e) => setNewOrgForm({ ...newOrgForm, adminUser: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Admin Password (min 8 chars)</label>
                      <input
                        type="password"
                        placeholder="••••••••"
                        value={newOrgForm.adminPassword}
                        onChange={(e) => setNewOrgForm({ ...newOrgForm, adminPassword: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[#737373] text-[11px] font-semibold mb-1">Admin Email (Optional)</label>
                    <input
                      type="email"
                      placeholder="admin@organisation.com"
                      value={newOrgForm.adminEmail}
                      onChange={(e) => setNewOrgForm({ ...newOrgForm, adminEmail: e.target.value })}
                      className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                  <button
                    type="button"
                    onClick={() => setShowNewOrg(false)}
                    className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !newOrgForm.name.trim() || !newOrgForm.code.trim()}
                    className="px-4 py-1.5 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs"
                  >
                    {busy ? 'Provisioning...' : 'Provision Organisation'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Modal: Issue Commercial License & Plan (Clean White Theme) */}
      {showIssueLicenseModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#171717]" /> Issue Commercial License & Plan
                </h3>
                <p className="text-[11px] text-[#737373] mt-0.5">
                  Select a created organisation and configure commercial plan tier, quotas, and module entitlements.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowIssueLicenseModal(false);
                  setCreatedLicenseSummary(null);
                }}
                className="text-[#737373] hover:text-[#171717] text-sm"
              >
                ✕
              </button>
            </div>

            {createdLicenseSummary ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#EAF5EF] border border-[#2F7D5A]/20 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-[#2F7D5A] font-bold text-sm">
                    <CheckCircle2 className="w-4 h-4" /> Commercial License Issued Successfully!
                  </div>
                  <p className="text-[12px] text-[#171717]">
                    The commercial license and enforceable entitlements are active for this organisation:
                  </p>
                  <div className="bg-white p-3 rounded border border-[#E5E5E0] font-mono text-xs space-y-1 text-[#171717]">
                    <div><strong>Organisation:</strong> {createdLicenseSummary.org.name} ({createdLicenseSummary.org.code})</div>
                    <div><strong>License Key:</strong> {createdLicenseSummary.license.license_key}</div>
                    <div><strong>Plan Tier:</strong> {createdLicenseSummary.license.plan_tier}</div>
                    <div><strong>Capacity Quota:</strong> {createdLicenseSummary.license.max_employees} Employees · {createdLicenseSummary.license.max_users} Users · {createdLicenseSummary.license.max_sites} Sites</div>
                    <div><strong>Valid Until:</strong> {new Date(createdLicenseSummary.license.end_date).toLocaleDateString()}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(createdLicenseSummary.license.license_key);
                      setLicenseCopied(true);
                      setTimeout(() => setLicenseCopied(false), 2000);
                    }}
                    className="px-3 py-1.5 bg-white hover:bg-[#FAFAF8] text-xs font-semibold text-[#171717] rounded border border-[#E5E5E0] flex items-center gap-1.5 shadow-xs"
                  >
                    <Copy className="w-3.5 h-3.5" /> {licenseCopied ? 'Copied License Key!' : 'Copy License Key'}
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setCreatedLicenseSummary(null);
                      setShowIssueLicenseModal(false);
                    }}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white font-semibold text-xs rounded transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleIssueLicense} className="space-y-3.5 text-xs">
                {/* 1. Organisation Selection - Selected from Dropdown only (Only Unlicensed) */}
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                    Organisation Name <span className="text-[#DC2626]">*</span>
                  </label>
                  {unlicensedOrgs.length > 0 ? (
                    <>
                      <select
                        required
                        value={issueLicenseForm.tenantId}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, tenantId: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-semibold focus:outline-none focus:border-[#171717]"
                      >
                        <option value="" disabled>-- Select Created Organisation --</option>
                        {unlicensedOrgs.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name} ({org.code})
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] text-[#737373] mt-1 block">
                        Showing {unlicensedOrgs.length} unlicensed organisation{unlicensedOrgs.length !== 1 ? 's' : ''}. Once a license is created, the organisation is enrolled in the active license directory and excluded from this creation list.
                      </span>
                    </>
                  ) : (
                    <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] space-y-1">
                      <div className="flex items-center gap-2 text-[#2F7D5A] font-bold text-xs">
                        <CheckCircle2 className="w-4 h-4" /> All Organisations Currently Have Active Licenses
                      </div>
                      <p className="text-[11px] text-[#737373]">
                        Every created organisation has already been issued an active commercial license. To modify seat quotas or enabled modules, click <strong>"Configure License"</strong> in the table below.
                      </p>
                    </div>
                  )}
                </div>

                {/* Selected Org Context Info */}
                {(() => {
                  const selectedOrg = organizations.find((o) => o.id === issueLicenseForm.tenantId);
                  const existingLic = licenses.find((l) => l.tenantId === issueLicenseForm.tenantId);
                  if (!selectedOrg) return null;
                  return (
                    <div className="p-2.5 bg-[#FAFAF8] rounded border border-[#E5E5E0] flex items-center justify-between text-[11px]">
                      <div>
                        <span className="font-semibold text-[#171717]">Selected: </span>
                        <span className="text-[#525252]">{selectedOrg.name}</span>
                        <span className="ml-1.5 font-mono px-1.5 py-0.5 rounded bg-white border border-[#E5E5E0] text-[10px]">{selectedOrg.code}</span>
                      </div>
                      <div className="text-[#737373]">
                        {existingLic ? (
                          <span className="text-[#2F7D5A] font-semibold">Active License: {existingLic.licenseKey}</span>
                        ) : (
                          <span>No Active License</span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* 2. Plan Tier Selection */}
                <div className="p-3.5 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] space-y-3">
                  <span className="block text-[11px] font-bold uppercase text-[#171717] tracking-wider">
                    Commercial Plan & Quotas
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Commercial Plan</label>
                      <select
                        value={issueLicenseForm.planTier}
                        onChange={(e) => {
                          const plan = e.target.value;
                          let emp = 355, users = 75, sites = 10;
                          if (plan === 'STARTER') { emp = 100; users = 20; sites = 2; }
                          else if (plan === 'PROFESSIONAL') { emp = 300; users = 50; sites = 5; }
                          else if (plan === 'ENTERPRISE') { emp = 355; users = 75; sites = 10; }
                          else if (plan === 'ENTERPRISE_PLUS') { emp = 5000; users = 500; sites = 50; }
                          setIssueLicenseForm((prev) => ({
                            ...prev,
                            planTier: plan,
                            maxEmployees: emp,
                            maxUsers: users,
                            maxSites: sites,
                          }));
                        }}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      >
                        <option value="STARTER">Starter</option>
                        <option value="PROFESSIONAL">Professional</option>
                        <option value="ENTERPRISE">Enterprise (355 Employees)</option>
                        <option value="ENTERPRISE_PLUS">Enterprise Plus</option>
                        <option value="CUSTOM">Custom Plan</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Employee Capacity Limit</label>
                      <input
                        type="number"
                        min="1"
                        required
                        value={issueLicenseForm.maxEmployees}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, maxEmployees: Number(e.target.value) })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Named Users</label>
                      <input
                        type="number"
                        min="1"
                        required
                        value={issueLicenseForm.maxUsers}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, maxUsers: Number(e.target.value) })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Max Sites</label>
                      <input
                        type="number"
                        min="1"
                        value={issueLicenseForm.maxSites}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, maxSites: Number(e.target.value) })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Max Workspaces</label>
                      <input
                        type="number"
                        min="1"
                        value={issueLicenseForm.maxWorkspaces}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, maxWorkspaces: Number(e.target.value) })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Valid Until</label>
                      <input
                        type="date"
                        value={issueLicenseForm.endDate}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, endDate: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                    <div>
                      <label className="block text-[#737373] text-[11px] font-semibold mb-1">Grace Period (Days)</label>
                      <input
                        type="number"
                        min="0"
                        value={issueLicenseForm.gracePeriodDays}
                        onChange={(e) => setIssueLicenseForm({ ...issueLicenseForm, gracePeriodDays: Number(e.target.value) })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. Module Entitlements */}
                <div className="p-3.5 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] space-y-2">
                  <span className="block text-[11px] font-bold uppercase text-[#171717] tracking-wider">
                    Feature & Module Entitlements
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                    {[
                      { key: 'FORECASTING', label: 'Forecasting' },
                      { key: 'SCHEDULING', label: 'Scheduling' },
                      { key: 'INTRADAY', label: 'Intraday Management' },
                      { key: 'ADHERENCE', label: 'Real-Time Adherence' },
                      { key: 'TIME_OFF', label: 'Time-Off & Leave' },
                      { key: 'SHIFT_BIDDING', label: 'Shift Bidding' },
                      { key: 'EMPLOYEE_SELF_SERVICE', label: 'Self Service' },
                      { key: 'REPORTING', label: 'Reporting & Analytics' },
                      { key: 'AI_COPILOT', label: 'AI WFM Copilot' },
                    ].map((m) => (
                      <label key={m.key} className="flex items-center gap-2 p-1.5 rounded hover:bg-white cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={!!issueLicenseForm.modules[m.key]}
                          onChange={(e) => {
                            const isChecked = e.target.checked;
                            setIssueLicenseForm({
                              ...issueLicenseForm,
                              modules: {
                                ...issueLicenseForm.modules,
                                [m.key]: isChecked,
                              },
                            });
                          }}
                          className="rounded border-[#E5E5E0] text-[#171717] focus:ring-0"
                        />
                        <span className="text-[11px] font-medium text-[#171717]">{m.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                  <button
                    type="button"
                    onClick={() => setShowIssueLicenseModal(false)}
                    className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !issueLicenseForm.tenantId || unlicensedOrgs.length === 0}
                    className="px-4 py-1.5 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs"
                  >
                    {busy ? 'Issuing...' : 'Issue Commercial License'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Modal: Edit License & Entitlements */}
      {showEditLicenseModal && selectedLicenseForEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#171717]" /> Configure License: {selectedLicenseForEdit.tenantName}
                </h3>
                <p className="text-[11px] text-[#737373] font-mono">{selectedLicenseForEdit.licenseKey}</p>
              </div>
              <button onClick={() => setShowEditLicenseModal(false)} className="text-[#737373] hover:text-[#171717] text-sm">✕</button>
            </div>

            <form onSubmit={handleSaveLicenseEdit} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Plan Tier</label>
                  <select
                    value={editLicenseForm.planTier}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, planTier: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    <option value="STARTER">Starter</option>
                    <option value="PROFESSIONAL">Professional</option>
                    <option value="ENTERPRISE">Enterprise</option>
                    <option value="ENTERPRISE_PLUS">Enterprise Plus</option>
                    <option value="CUSTOM">Custom Plan</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">License Status</label>
                  <select
                    value={editLicenseForm.status}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, status: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="GRACE_PERIOD">GRACE_PERIOD</option>
                    <option value="SUSPENDED">SUSPENDED</option>
                    <option value="EXPIRED">EXPIRED</option>
                    <option value="CANCELLED">CANCELLED</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                    Employee Capacity (Active Agents)
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={editLicenseForm.maxEmployees}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, maxEmployees: Number(e.target.value) })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                  />
                  <span className="text-[10px] text-[#737373]">Current active: {selectedLicenseForEdit.activeEmployees || 0}</span>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">
                    Named Users Limit
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={editLicenseForm.maxUsers}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, maxUsers: Number(e.target.value) })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                  />
                  <span className="text-[10px] text-[#737373]">Current active: {selectedLicenseForEdit.activeUsers || 0}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Expiration Date</label>
                  <input
                    type="date"
                    value={editLicenseForm.endDate}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, endDate: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Grace Period (Days)</label>
                  <input
                    type="number"
                    min="0"
                    value={editLicenseForm.gracePeriodDays}
                    onChange={(e) => setEditLicenseForm({ ...editLicenseForm, gracePeriodDays: Number(e.target.value) })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-2">Enabled Modules</label>
                <div className="grid grid-cols-2 gap-2 border border-[#E5E5E0] p-3 rounded bg-[#FAFAF8]">
                  {[
                    ['FORECASTING', 'Forecasting Engine'],
                    ['SCHEDULING', 'Automated Scheduling'],
                    ['INTRADAY', 'Intraday & RTA'],
                    ['ADHERENCE', 'Real-Time Adherence'],
                    ['TIME_OFF', 'Time Off Management'],
                    ['SHIFT_BIDDING', 'Shift Bidding & Swaps'],
                    ['EMPLOYEE_SELF_SERVICE', 'Employee Self-Service'],
                    ['REPORTING', 'Reporting & Analytics'],
                    ['AI_COPILOT', 'AI WFM Copilot'],
                  ].map(([code, label]) => (
                    <label key={code} className="flex items-center gap-2 cursor-pointer text-[12px] text-[#171717]">
                      <input
                        type="checkbox"
                        checked={!!editLicenseForm.modules?.[code]}
                        onChange={(e) =>
                          setEditLicenseForm({
                            ...editLicenseForm,
                            modules: {
                              ...editLicenseForm.modules,
                              [code]: e.target.checked,
                            },
                          })
                        }
                        className="rounded border-[#E5E5E0] text-[#171717] focus:ring-0"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                <button
                  type="button"
                  onClick={() => setShowEditLicenseModal(false)}
                  className="px-3 py-1.5 border border-[#E5E5E0] text-[#737373] hover:text-[#171717] rounded text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-1.5 bg-[#171717] hover:bg-[#333333] text-white font-semibold text-xs rounded transition-colors"
                >
                  {busy ? 'Saving…' : 'Save License Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Organisation Workspaces (Clean White Theme) */}
      {selectedOrgForWs && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-[#171717]" /> Workspaces in {selectedOrgForWs.name}
                </h3>
                <p className="text-[#737373] text-[12px] mt-0.5">
                  All workspaces within this organisation share its billing and tenant boundary, with strictly isolated operational data.
                </p>
              </div>
              <button onClick={() => setSelectedOrgForWs(null)} className="text-[#737373] hover:text-[#171717] text-sm">✕</button>
            </div>

            {/* Workspaces list */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#171717] text-[13px]">Existing Workspaces ({orgWorkspaces.length})</span>
                {!showAddWsForm && (
                  <button
                    onClick={() => setShowAddWsForm(true)}
                    className="flex items-center gap-1 px-2.5 py-1 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] transition-colors shadow-xs"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Workspace
                  </button>
                )}
              </div>

              {showAddWsForm && (
                <form onSubmit={handleCreateWorkspace} className="p-3.5 bg-[#FAFAF8] rounded-lg border border-[#E5E5E0] space-y-3">
                  <div className="font-semibold text-[#171717] text-[13px]">Create New Workspace in {selectedOrgForWs.code}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-[#737373] mb-1">Name</label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Backoffice & Support"
                        value={newWsForm.name}
                        onChange={(e) => {
                          const name = e.target.value;
                          const code = name.replace(/[^A-Za-z0-9]/g, '_').slice(0, 16).toUpperCase();
                          setNewWsForm((prev) => ({
                            ...prev,
                            name,
                            code: prev.code ? prev.code : code,
                            slug: name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30),
                          }));
                        }}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-[#737373] mb-1">Code</label>
                      <input
                        type="text"
                        required
                        value={newWsForm.code}
                        onChange={(e) => setNewWsForm({ ...newWsForm, code: e.target.value.toUpperCase() })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] font-mono focus:outline-none focus:border-[#171717]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-[#737373] mb-1">Timezone</label>
                      <select
                        value={newWsForm.timezone}
                        onChange={(e) => setNewWsForm({ ...newWsForm, timezone: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      >
                        {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-[#737373] mb-1">Currency</label>
                      <select
                        value={newWsForm.currency}
                        onChange={(e) => setNewWsForm({ ...newWsForm, currency: e.target.value })}
                        className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                      >
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAddWsForm(false)}
                      className="px-2.5 py-1 bg-white border border-[#E5E5E0] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !newWsForm.name || !newWsForm.code}
                      className="px-3 py-1 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs"
                    >
                      {busy ? 'Saving...' : 'Create Workspace'}
                    </button>
                  </div>
                </form>
              )}

              <div className="border border-[#E5E5E0] rounded-lg overflow-hidden">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-[#FAFAF8] border-b border-[#E5E5E0] text-[#737373] text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="p-2.5 font-semibold">Workspace</th>
                      <th className="p-2.5 font-semibold">Code / Slug</th>
                      <th className="p-2.5 font-semibold">Status</th>
                      <th className="p-2.5 font-semibold">Members</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E5E0] text-[#171717]">
                    {orgWorkspaces.map((w) => (
                      <tr key={w.id} className="hover:bg-[#FAFAF8] transition-colors">
                        <td className="p-2.5 font-semibold text-[#171717]">
                          <div className="flex items-center gap-1.5">
                            {w.name}
                            {(w.isDefault ?? w.is_default) && (
                              <span className="text-[10px] bg-[#EDF3F8] text-[#4F6F8F] border border-[#4F6F8F]/20 px-1.5 py-0.5 rounded font-mono font-semibold">
                                DEFAULT
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-2.5 font-mono text-[#171717]">
                          {w.code} <span className="text-[#737373] text-[11px]">({w.slug})</span>
                        </td>
                        <td className="p-2.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                            w.status === 'ACTIVE'
                              ? 'bg-[#EAF5EF] text-[#2F7D5A] border-[#2F7D5A]/20'
                              : 'bg-[#FAFAF8] text-[#737373] border-[#E5E5E0]'
                          }`}>
                            {w.status}
                          </span>
                        </td>
                        <td className="p-2.5 text-[#171717] font-mono">{w.memberCount ?? w.member_count ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-[#E5E5E0]">
              <button
                onClick={() => setSelectedOrgForWs(null)}
                className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Add Organisation Administrator (Clean White Theme) */}
      {selectedOrgForAdmin && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-md w-full p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                  <Key className="w-4 h-4 text-[#171717]" /> Provision Admin for {selectedOrgForAdmin.name}
                </h3>
                <p className="text-[#737373] text-[12px] mt-0.5">
                  Grants full WFM_ADMIN role within organisation {selectedOrgForAdmin.code}.
                </p>
              </div>
              <button onClick={() => setSelectedOrgForAdmin(null)} className="text-[#737373] hover:text-[#171717] text-sm">✕</button>
            </div>

            <form onSubmit={handleCreateAdmin} className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Username</label>
                <input
                  type="text"
                  required
                  value={newAdminForm.username}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, username: e.target.value })}
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Password (min 8 characters)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newAdminForm.password}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Display Name</label>
                <input
                  type="text"
                  value={newAdminForm.displayName}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, displayName: e.target.value })}
                  placeholder="e.g. John Doe"
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Email (Optional)</label>
                <input
                  type="email"
                  value={newAdminForm.email}
                  onChange={(e) => setNewAdminForm({ ...newAdminForm, email: e.target.value })}
                  placeholder="admin@organisation.com"
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                <button
                  type="button"
                  onClick={() => setSelectedOrgForAdmin(null)}
                  className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !newAdminForm.username || !newAdminForm.password}
                  className="px-4 py-1.5 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs"
                >
                  {busy ? 'Creating...' : 'Provision Admin'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Edit Organisation Settings (Clean White Theme) */}
      {selectedOrgForEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-md w-full p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <h3 className="text-[16px] font-bold text-[#171717] flex items-center gap-2">
                <Settings className="w-4 h-4 text-[#171717]" /> Edit Organisation: {selectedOrgForEdit.code}
              </h3>
              <button onClick={() => setSelectedOrgForEdit(null)} className="text-[#737373] hover:text-[#171717] text-sm">✕</button>
            </div>

            <form onSubmit={handleSaveOrgEdit} className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Display Name</label>
                <input
                  type="text"
                  required
                  value={editOrgForm.displayName}
                  onChange={(e) => setEditOrgForm({ ...editOrgForm, displayName: e.target.value })}
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[#171717] mb-1">Legal Name</label>
                <input
                  type="text"
                  value={editOrgForm.legalName}
                  onChange={(e) => setEditOrgForm({ ...editOrgForm, legalName: e.target.value })}
                  className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Timezone</label>
                  <select
                    value={editOrgForm.timezone}
                    onChange={(e) => setEditOrgForm({ ...editOrgForm, timezone: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Currency</label>
                  <select
                    value={editOrgForm.currency}
                    onChange={(e) => setEditOrgForm({ ...editOrgForm, currency: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Contact Name</label>
                  <input
                    type="text"
                    value={editOrgForm.contactName}
                    onChange={(e) => setEditOrgForm({ ...editOrgForm, contactName: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-[#171717] mb-1">Contact Email</label>
                  <input
                    type="email"
                    value={editOrgForm.contactEmail}
                    onChange={(e) => setEditOrgForm({ ...editOrgForm, contactEmail: e.target.value })}
                    className="w-full p-2 border border-[#E5E5E0] rounded text-[13px] bg-white text-[#171717] focus:outline-none focus:border-[#171717]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                <button
                  type="button"
                  onClick={() => setSelectedOrgForEdit(null)}
                  className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-1.5 bg-[#171717] hover:bg-[#333333] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs"
                >
                  {busy ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Emergency Credential Reset */}
      {showEmergencyResetModal && targetAdminForReset && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white border border-[#E5E5E0] rounded-lg shadow-2xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#FFF8EB] border border-[#B35900]/20 flex items-center justify-center text-[#B35900]">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-[16px] font-bold text-[#171717]">Emergency Credential Reset</h3>
                  <p className="text-[12px] text-[#737373]">
                    Access recovery for organisation administrator
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowEmergencyResetModal(false);
                  setTargetAdminForReset(null);
                  setResetResult(null);
                }}
                className="text-[#737373] hover:text-[#171717] text-sm"
              >
                ✕
              </button>
            </div>

            {resetResult ? (
              <div className="space-y-4">
                <div className="p-4 bg-[#EAF5EF] border border-[#2F7D5A]/20 rounded-lg space-y-3">
                  <div className="flex items-center gap-2 text-[#2F7D5A] font-bold text-sm">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Emergency Recovery Credentials Generated!</span>
                  </div>
                  <p className="text-[12px] text-[#171717]">
                    The administrator account status has been restored to <strong>ACTIVE</strong>. When they sign in, they will be required to choose a new permanent password.
                  </p>

                  <div className="bg-white p-3 rounded border border-[#E5E5E0] text-[12px] space-y-1.5 text-[#171717]">
                    <div>
                      <span className="text-[#737373]">Target User:</span>{' '}
                      <strong>{resetResult.user.username}</strong>
                      {resetResult.user.email && ` (${resetResult.user.email})`}
                    </div>
                    <div>
                      <span className="text-[#737373]">Organisation:</span>{' '}
                      <strong>{resetResult.user.tenantName}</strong> [{resetResult.user.tenantCode}]
                    </div>
                    <div>
                      <span className="text-[#737373]">Validity:</span>{' '}
                      <span className="font-mono text-[#B35900] font-semibold">Valid for 24 hours</span>
                    </div>
                  </div>

                  {resetResult.temporaryPassword && (
                    <div className="bg-white p-3 rounded border border-[#E5E5E0] space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
                        <span>Temporary One-Time Password</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(resetResult.temporaryPassword!);
                            setResetCopied('PWD');
                            setTimeout(() => setResetCopied(null), 2000);
                          }}
                          className="text-[#171717] hover:underline flex items-center gap-1 font-sans capitalize font-semibold"
                        >
                          <Copy className="w-3 h-3" />
                          {resetCopied === 'PWD' ? 'Copied!' : 'Copy Password'}
                        </button>
                      </div>
                      <div className="font-mono text-[14px] font-bold text-[#171717] bg-[#FAFAF8] p-2 rounded border border-[#E5E5E0] select-all">
                        {resetResult.temporaryPassword}
                      </div>
                      <p className="text-[11px] text-[#737373]">
                        Instruct the admin to sign in using this temporary password.
                      </p>
                    </div>
                  )}

                  {resetResult.resetUrl && (
                    <div className="bg-white p-3 rounded border border-[#E5E5E0] space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-[#737373] uppercase tracking-wider">
                        <span>Direct Password Reset Link</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(resetResult.resetUrl!);
                            setResetCopied('LINK');
                            setTimeout(() => setResetCopied(null), 2000);
                          }}
                          className="text-[#171717] hover:underline flex items-center gap-1 font-sans capitalize font-semibold"
                        >
                          <Copy className="w-3 h-3" />
                          {resetCopied === 'LINK' ? 'Copied!' : 'Copy Link'}
                        </button>
                      </div>
                      <div className="font-mono text-[11px] text-[#171717] bg-[#FAFAF8] p-2 rounded border border-[#E5E5E0] break-all select-all">
                        {resetResult.resetUrl}
                      </div>
                      <p className="text-[11px] text-[#737373]">
                        One-click redemption URL. Admin can open this to directly set their new password without an existing login.
                      </p>
                    </div>
                  )}

                  <div className="pt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const text = [
                          `[WFM PLATFORM EMERGENCY ACCESS RECOVERY]`,
                          `Organisation: ${resetResult.user.tenantName} (${resetResult.user.tenantCode})`,
                          `Username: ${resetResult.user.username}`,
                          resetResult.temporaryPassword ? `Temporary Password: ${resetResult.temporaryPassword}` : null,
                          resetResult.resetUrl ? `Direct Reset URL: ${resetResult.resetUrl}` : null,
                          `Expires: Valid for 24 hours`,
                          `Note: You will be required to change your password immediately upon signing in.`,
                        ].filter(Boolean).join('\n');
                        navigator.clipboard.writeText(text);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="px-3 py-1.5 bg-white hover:bg-[#FAFAF8] text-xs font-semibold text-[#171717] rounded border border-[#E5E5E0] flex items-center gap-1.5 shadow-xs"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{copied ? 'All Details Copied!' : 'Copy All Recovery Details'}</span>
                    </button>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      setShowEmergencyResetModal(false);
                      setTargetAdminForReset(null);
                      setResetResult(null);
                    }}
                    className="px-4 py-2 bg-[#171717] hover:bg-[#333333] text-white font-semibold text-xs rounded transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                {/* Admin info card */}
                <div className="p-3 bg-[#FAFAF8] rounded border border-[#E5E5E0] space-y-1 text-[#171717]">
                  <div className="text-[11px] font-semibold text-[#737373] uppercase tracking-wider mb-1">
                    Target Administrator
                  </div>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-bold text-[#171717]">{targetAdminForReset.username}</span>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-white border border-[#E5E5E0]">
                      {targetAdminForReset.orgCode}
                    </span>
                  </div>
                  {targetAdminForReset.email && (
                    <div className="text-[#737373] text-[12px]">{targetAdminForReset.email}</div>
                  )}
                  <div className="text-[#737373] text-[12px]">
                    Organisation: <strong>{targetAdminForReset.orgName}</strong>
                  </div>
                </div>

                <div className="p-3 bg-[#FFF8EB] border border-[#B35900]/20 rounded text-[#171717] text-[12px] space-y-1">
                  <div className="font-bold text-[#B35900] flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4" />
                    <span>Emergency Credential Recovery Action</span>
                  </div>
                  <p className="text-[#737373]">
                    This action will be logged in the immutable Platform Audit Trail with your Super Admin identity and client IP address. The administrator will be forced to change their password on first sign-in.
                  </p>
                </div>

                {/* Reset Method Selection */}
                <div className="space-y-2">
                  <label className="block text-[12px] font-semibold text-[#171717]">
                    Recovery Method
                  </label>
                  <div className="space-y-2">
                    <label className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                      resetMethod === 'BOTH'
                        ? 'bg-[#FAFAF8] border-[#171717]'
                        : 'bg-white border-[#E5E5E0] hover:bg-[#FAFAF8]'
                    }`}>
                      <input
                        type="radio"
                        name="resetMethod"
                        value="BOTH"
                        checked={resetMethod === 'BOTH'}
                        onChange={() => setResetMethod('BOTH')}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-semibold text-[#171717] text-[12px]">
                          Temporary Password + Direct Reset Link <span className="text-[#2F7D5A] font-bold">(Recommended)</span>
                        </div>
                        <div className="text-[#737373] text-[11px] mt-0.5">
                          Generates a high-entropy temporary password and an out-of-band one-click reset URL valid for 24 hours.
                        </div>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                      resetMethod === 'TEMPORARY_PASSWORD'
                        ? 'bg-[#FAFAF8] border-[#171717]'
                        : 'bg-white border-[#E5E5E0] hover:bg-[#FAFAF8]'
                    }`}>
                      <input
                        type="radio"
                        name="resetMethod"
                        value="TEMPORARY_PASSWORD"
                        checked={resetMethod === 'TEMPORARY_PASSWORD'}
                        onChange={() => setResetMethod('TEMPORARY_PASSWORD')}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-semibold text-[#171717] text-[12px]">
                          Temporary Password Only
                        </div>
                        <div className="text-[#737373] text-[11px] mt-0.5">
                          Admin enters their username and the temporary password on the tenant login screen.
                        </div>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                      resetMethod === 'RESET_LINK'
                        ? 'bg-[#FAFAF8] border-[#171717]'
                        : 'bg-white border-[#E5E5E0] hover:bg-[#FAFAF8]'
                    }`}>
                      <input
                        type="radio"
                        name="resetMethod"
                        value="RESET_LINK"
                        checked={resetMethod === 'RESET_LINK'}
                        onChange={() => setResetMethod('RESET_LINK')}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-semibold text-[#171717] text-[12px]">
                          Direct Reset Link Only
                        </div>
                        <div className="text-[#737373] text-[11px] mt-0.5">
                          Generates a cryptographic 24-hour token URL for immediate out-of-band password update.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-[#E5E5E0]">
                  <button
                    type="button"
                    onClick={() => {
                      setShowEmergencyResetModal(false);
                      setTargetAdminForReset(null);
                    }}
                    className="px-3 py-1.5 border border-[#E5E5E0] bg-white hover:bg-[#FAFAF8] text-[#171717] rounded text-[12px] font-semibold transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handlePerformEmergencyReset}
                    className="px-4 py-1.5 bg-[#B35900] hover:bg-[#904700] text-white font-semibold rounded text-[12px] disabled:opacity-50 transition-colors shadow-xs flex items-center gap-1.5"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{busy ? 'Generating...' : 'Generate Emergency Credentials'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
