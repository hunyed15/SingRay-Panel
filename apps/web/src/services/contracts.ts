// 响应契约(zod):前端不再 `data as T` 裸转 —— 后端字段改名/漏字段时,
// 在 api 层立刻报 bad_response 并指出是哪个字段,而不是等页面在渲染时崩掉。
//
// 约定:
// - 一律 looseObject:后端将来加字段不会把前端打挂(多余 key 原样保留);
// - 每个 schema 的类型必须能赋给 types.ts 里对应的接口(编译期双向校验,见文件底部);
// - 可选字段与 types.ts 保持一致(? ↔ .optional(),| null ↔ .nullable())。
import { z } from 'zod';
import type { NodeItem, PortForwardItem, Server, Settings, SniItem, XrayNodeItem } from './types';
import type { CertOverviewRow, PendingDeployRow, ProbeRow, SystemStatus } from './api';

const nodeProtocol = z.enum([
  'vless',
  'vmess',
  'anytls',
  'hysteria',
  'socks',
  'http',
  'tunnel',
  'tuic',
  'shadowtls',
  'naive',
]);
const xrayProtocol = z.enum(['vless', 'vmess', 'socks', 'http']);

const pingStatus = z.enum(['online', 'inactive', 'offline', 'unknown']);
const role = z.enum(['relay', 'landing']);
const control = z.enum(['ssh', 'agent']);
const tlsMode = z.enum(['none', 'reality', 'tls', 'shadowtls']);
const xrayTlsMode = z.enum(['none', 'reality', 'tls']);
const transport = z.enum(['raw', 'ws', 'tcp', 'xhttp']);
const mechanism = z.enum(['iptables', 'socat']);
const outboundType = z.enum(['direct', 'relay']);

export const serverSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  role,
  control,
  host: z.string(),
  clientHost: z.string(),
  sshPort: z.number(),
  sshUser: z.string(),
  sshAuthType: z.enum(['key', 'password']),
  sshSudo: z.number(),
  region: z.string(),
  pingStatus,
  singboxVersion: z.string(),
  xrayVersion: z.string(),
  xrayPingStatus: pingStatus,
  xrayLastSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  jumpServerId: z.number().nullable(),
  ipStack: z.enum(['v4', 'v6', 'dual', 'unknown']),
  relayMechanism: mechanism,
  preferViaServerId: z.number().nullable(),
  portAllow: z.string(),
});

export const nodeSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  serverId: z.number(),
  serverName: z.string(),
  protocol: nodeProtocol,
  listenPort: z.number(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  tlsMode,
  transport,
  sni: z.string().optional(),
  tunnelAddress: z.string().optional(),
  tunnelPort: z.number().optional(),
  authUser: z.string().optional(),
  authPassword: z.string().optional(),
  outboundType,
  landingServerId: z.number().optional(),
  landingName: z.string().optional(),
  shareLink: z.string().nullable(),
  note: z.string(),
  createdAt: z.string(),
});

export const xrayNodeSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  serverId: z.number(),
  serverName: z.string(),
  protocol: xrayProtocol,
  listenPort: z.number(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  tlsMode: xrayTlsMode,
  transport,
  sni: z.string().optional(),
  wsPath: z.string().optional(),
  flow: z.string().optional(),
  outboundType,
  landingServerId: z.number().optional(),
  landingName: z.string().optional(),
  shareLink: z.string().nullable(),
  note: z.string(),
  createdAt: z.string(),
  authUser: z.string().optional(),
  authPassword: z.string().optional(),
});

export const sniSchema = z.looseObject({
  id: z.number(),
  domain: z.string(),
  note: z.string(),
  builtin: z.number(),
});

export const settingsSchema = z.looseObject({
  subSlug: z.string(),
  subUrl: z.string(),
  singboxRealityIp: z.boolean(),
  xrayRealityIp: z.boolean(),
  cfTokenSet: z.boolean(),
  cfTokenSource: z.enum(['db', 'env', 'none']),
  tgBotTokenSet: z.boolean(),
  tgChatId: z.string(),
});

export const portForwardSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  entryServerId: z.number(),
  entryServerName: z.string(),
  landingServerId: z.number(),
  landingServerName: z.string(),
  targetNodeType: z.enum(['singbox', 'xray', 'port']),
  targetNodeId: z.number(),
  targetNodeName: z.string(),
  entryPort: z.number(),
  targetPort: z.number(),
  mechanism,
  enabled: z.number(),
  includeInSub: z.number(),
  note: z.string(),
  createdAt: z.string(),
  auto: z.number(),
  core: z.enum(['singbox', 'xray', '']),
});

export const probeSchema = z.looseObject({
  nodeType: z.enum(['singbox', 'xray']),
  nodeId: z.number(),
  nodeName: z.string(),
  ok: z.boolean(),
  latencyMs: z.number(),
  detail: z.string(),
  checkedAt: z.string(),
});

export const certOverviewSchema = z.looseObject({
  serverId: z.number(),
  name: z.string(),
  domain: z.string(),
  acmeInstalled: z.boolean(),
  certExists: z.boolean(),
  expiresAt: z.string().nullable(),
  reachable: z.boolean(),
  error: z.string().optional(),
});

export const pendingDeploySchema = z.looseObject({
  serverId: z.number(),
  name: z.string(),
  singbox: z.boolean(),
  xray: z.boolean(),
});

export const systemStatusSchema = z.looseObject({
  jobs: z.array(
    z.looseObject({
      name: z.string(),
      intervalMs: z.number(),
      lastOk: z.boolean().nullable(),
      lastAt: z.number().nullable(),
      lastDetail: z.string(),
      nextInSec: z.number().nullable(),
    }),
  ),
  backups: z.array(z.looseObject({ file: z.string(), size: z.number(), mtime: z.number() })),
  tgConfigured: z.boolean(),
  healthIntervalMin: z.number(),
  backupRetention: z.number(),
  backupHour: z.number(),
  probeIntervalMin: z.number(),
});

// ---- 编译期双向校验:schema 的产出必须能当接口用,接口的必填键也必须在 schema 里 ----
// (少写一个字段 → 下面的赋值报错;写错字段名 → 同样报错)
type Out<S extends z.ZodType> = z.infer<S>;
const _server: Server = null as unknown as Out<typeof serverSchema>;
const _node: NodeItem = null as unknown as Out<typeof nodeSchema>;
const _xrayNode: XrayNodeItem = null as unknown as Out<typeof xrayNodeSchema>;
const _sni: SniItem = null as unknown as Out<typeof sniSchema>;
const _settings: Settings = null as unknown as Out<typeof settingsSchema>;
const _forward: PortForwardItem = null as unknown as Out<typeof portForwardSchema>;
const _probe: ProbeRow = null as unknown as Out<typeof probeSchema>;
const _cert: CertOverviewRow = null as unknown as Out<typeof certOverviewSchema>;
const _pending: PendingDeployRow = null as unknown as Out<typeof pendingDeploySchema>;
const _sys: SystemStatus = null as unknown as Out<typeof systemStatusSchema>;
void [_server, _node, _xrayNode, _sni, _settings, _forward, _probe, _cert, _pending, _sys];
