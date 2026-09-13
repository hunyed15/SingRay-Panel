/**
 * API 统一封装:fetch + Bearer + 统一错误提示(antd message)。
 * 约定:本层对失败请求弹出 message.error 并抛出 ApiError;页面 catch 中只需
 * 处理状态复位,不必重复弹错(避免双重提示)。
 */
import { message } from 'antd';
import { clearToken, getToken, setToken } from './auth';
import type {
  AccountPatch,
  DeployAllResult,
  LoginResult,
  NodeCreateInput,
  NodeItem,
  NodePatch,
  NodeTestResult,
  PortForwardCreateInput,
  PortForwardItem,
  Server,
  ServerInput,
  Settings,
  SniItem,
  TestResult,
  XrayNodeCreateInput,
  XrayNodeItem,
  XrayNodePatch,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 静默模式:失败不弹全局 message(由调用方自行展示) */
  silent?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: {
        // 仅带 body 时声明 JSON,避免 Fastify 对空 body + JSON 头返回 400
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const err = new ApiError(0, '无法连接面板后端,请检查服务是否启动');
    if (!opts.silent) message.error(err.message);
    throw err;
  }

  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'unauthorized') {
      // 会话过期:清 token 回登录页(登录页的业务性 401 走普通错误分支)
      clearToken();
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
      const err = new ApiError(401, '登录已过期,请重新登录');
      if (!opts.silent) message.error(err.message);
      throw err;
    }
    const err = new ApiError(401, body.error ?? '请求未授权');
    if (!opts.silent) message.error(err.message);
    throw err;
  }

  const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) {
    const err = new ApiError(res.status, data.error ?? `请求失败(HTTP ${res.status})`);
    if (!opts.silent) message.error(err.message);
    throw err;
  }
  return data as T;
}

// ---------- 认证 ----------

export const login = async (username: string, password: string): Promise<LoginResult> => {
  const data = await request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setToken(data.token);
  return data;
};

export const getMe = (): Promise<{ username: string }> => request('/api/auth/me');

export const updateAccount = (payload: AccountPatch): Promise<{ username: string }> =>
  request('/api/auth/account', { method: 'PUT', body: payload });

// ---------- 服务器 ----------

export const getServers = (): Promise<Server[]> => request<Server[]>('/api/servers');

export const createServer = (payload: ServerInput): Promise<Server> =>
  request<Server>('/api/servers', { method: 'POST', body: payload });

export const updateServer = (id: number, payload: Partial<ServerInput>): Promise<Server> =>
  request<Server>(`/api/servers/${id}`, { method: 'PUT', body: payload });

export const deleteServer = (id: number): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/servers/${id}`, { method: 'DELETE' });

/** SSH 连通性测试(agent 模式返回 ok=false + 提示) */
export const testServer = (id: number): Promise<TestResult> =>
  request<TestResult>(`/api/servers/${id}/test`, { method: 'POST' });

// ---------- SingBox 节点 ----------

export const getNodes = (): Promise<NodeItem[]> => request<NodeItem[]>('/api/nodes');

export const createNode = (payload: NodeCreateInput): Promise<NodeItem> =>
  request<NodeItem>('/api/nodes', { method: 'POST', body: payload });

export const updateNode = (id: number, payload: NodePatch): Promise<NodeItem> =>
  request<NodeItem>(`/api/nodes/${id}`, { method: 'PUT', body: payload });

export const toggleNode = (id: number): Promise<NodeItem> =>
  request<NodeItem>(`/api/nodes/${id}/toggle`, { method: 'POST' });

export const deleteNode = (id: number): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/nodes/${id}`, { method: 'DELETE' });

/** 节点测速:返回延迟 ms 或失败详情 */
export const testNode = (id: number): Promise<NodeTestResult> =>
  request<NodeTestResult>(`/api/test/nodes/${id}`, { method: 'POST' });

// ---------- Xray 节点 ----------

export const getXrayNodes = (): Promise<XrayNodeItem[]> => request<XrayNodeItem[]>('/api/xray/nodes');

export const createXrayNode = (payload: XrayNodeCreateInput): Promise<XrayNodeItem> =>
  request<XrayNodeItem>('/api/xray/nodes', { method: 'POST', body: payload });

export const updateXrayNode = (id: number, payload: XrayNodePatch): Promise<XrayNodeItem> =>
  request<XrayNodeItem>(`/api/xray/nodes/${id}`, { method: 'PUT', body: payload });

export const toggleXrayNode = (id: number): Promise<XrayNodeItem> =>
  request<XrayNodeItem>(`/api/xray/nodes/${id}/toggle`, { method: 'POST' });

export const deleteXrayNode = (id: number): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/xray/nodes/${id}`, { method: 'DELETE' });

export const testXrayNode = (id: number): Promise<NodeTestResult> =>
  request<NodeTestResult>(`/api/test/xray-nodes/${id}`, { method: 'POST' });

// ---------- SNI 域名库 ----------

export const getSnis = (): Promise<SniItem[]> => request<SniItem[]>('/api/snis');

export const createSni = (domain: string, note: string): Promise<SniItem> =>
  request<SniItem>('/api/snis', { method: 'POST', body: { domain, note } });

export const updateSni = (id: number, payload: { domain?: string; note?: string }): Promise<SniItem> =>
  request<SniItem>(`/api/snis/${id}`, { method: 'PUT', body: payload });

export const deleteSni = (id: number): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/snis/${id}`, { method: 'DELETE' });

// ---------- 设置 ----------

export const getSettings = (): Promise<Settings> => request<Settings>('/api/settings');

export const setSlug = (subSlug: string): Promise<Settings> =>
  request<Settings>('/api/settings', { method: 'PUT', body: { subSlug } });

/** 更新订阅 Reality 地址模式等设置 */
export const updateSettings = (
  patch: { singboxRealityIp?: boolean; xrayRealityIp?: boolean },
): Promise<Settings> => request<Settings>('/api/settings', { method: 'PUT', body: patch });

// ---------- 中转规则 ----------

export const getPortForwards = (): Promise<PortForwardItem[]> =>
  request<PortForwardItem[]>('/api/port-forwards');

export const createPortForward = (
  payload: PortForwardCreateInput,
): Promise<{ port_forward: PortForwardItem }> =>
  request<{ port_forward: PortForwardItem }>('/api/port-forwards', {
    method: 'POST',
    body: payload,
  });

export const deletePortForward = (id: number): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/port-forwards/${id}`, { method: 'DELETE' });

/** 更新中转规则(订阅整合开关) */
export const updatePortForward = (id: number, patch: { includeInSub: boolean }): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/port-forwards/${id}`, { method: 'PUT', body: patch });

export interface ForwardPreflight {
  iptablesAvailable: boolean;
  socatAvailable: boolean;
  ipForward: '1' | '0' | 'unknown';
  entryPortBusy: boolean;
  issues: string[];
}

/** 新建向导第 5 步前预检入口机(iptables/socat 可用性、ip_forward、端口占用) */
export const preflightPortForward = (entryServerId: number, entryPort?: number): Promise<ForwardPreflight> =>
  request<ForwardPreflight>('/api/port-forwards/preflight', {
    method: 'POST',
    body: { entryServerId, entryPort: entryPort ? Number(entryPort) : undefined },
  });

export interface ForwardReconcileReport {
  actualIptables: string[];
  actualSocatUnits: string[];
  missingIptables: number[];
  missingSocat: number[];
  orphanIptables: string[];
  orphanSocat: string[];
}

/** 对账:入口机实际规则 vs DB */
export const reconcilePortForwards = (entryServerId: number): Promise<ForwardReconcileReport> =>
  request<ForwardReconcileReport>('/api/port-forwards/reconcile', {
    method: 'POST',
    body: { entryServerId },
  });

// ---------- 一键部署 ----------

export const deployAll = (): Promise<{ results: DeployAllResult[] }> =>
  request<{ results: DeployAllResult[] }>('/api/deploy/all', { method: 'POST' });

/** 单机部署(sing-box + xray) */
export const deployServer = (id: number): Promise<DeployAllResult> =>
  request<DeployAllResult>(`/api/deploy/${id}`, { method: 'POST' });

/** 单机单核心部署 */
export const deployServerCore = (id: number, core: 'singbox' | 'xray'): Promise<DeployAllResult> =>
  request<DeployAllResult>(`/api/deploy/${id}`, { method: 'POST', body: { core } });

export interface BatchNodesResult {
  created: { name: string; port: number }[];
  skipped: { template: string; reason: string }[];
}

/** 一键添加模板节点(同模板已存在自动跳过) */
export const batchCreateNodes = (
  id: number,
  payload: { core: 'singbox' | 'xray'; templates: string[]; realitySni?: string },
): Promise<BatchNodesResult> =>
  request<BatchNodesResult>(`/api/servers/${id}/batch-nodes`, { method: 'POST', body: payload });

export interface CertStatusInfo {
  acmeInstalled: boolean;
  certExists: boolean;
  expiresAt: string | null;
  domain: string;
}

export interface CertOverviewRow {
  serverId: number;
  name: string;
  domain: string;
  acmeInstalled: boolean;
  certExists: boolean;
  expiresAt: string | null;
  reachable: boolean;
  error?: string;
}

/** 全机器证书状态聚合 */
export const getCerts = (): Promise<CertOverviewRow[]> => request<CertOverviewRow[]>('/api/servers/certs');

export const getCertStatus = (id: number): Promise<CertStatusInfo> =>
  request<CertStatusInfo>(`/api/servers/${id}/cert-status`);

export const issueCert = (id: number): Promise<{ ok?: boolean; steps?: string[]; error?: string }> =>
  request<{ ok?: boolean; steps?: string[]; error?: string }>(`/api/servers/${id}/issue-cert`, { method: 'POST' });

export type LifecycleAction = 'install' | 'restart' | 'uninstall';

/** 核心生命周期:install/restart/uninstall(sing-box: /:id/<action>;xray: /:id/xray-<action>,与旧版路径一致) */
export const serverLifecycle = (
  id: number,
  core: 'singbox' | 'xray',
  action: LifecycleAction,
): Promise<{ ok: boolean; steps?: string[]; error?: string }> =>
  request<{ ok: boolean; steps?: string[]; error?: string }>(
    core === 'xray' ? `/api/servers/${id}/xray-${action}` : `/api/servers/${id}/${action}`,
    { method: 'POST' },
  );
