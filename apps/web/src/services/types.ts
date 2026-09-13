/**
 * 数据契约:与 SingRayPanel 后端(apps/server)对齐,路由形状见 apps/server/src/routes/*。
 * 服务器/节点等行均为 snake_case(直出 SQLite 行),写路径入参为 camelCase。
 */

export type ServerRole = 'relay' | 'landing';
export type ControlMode = 'ssh' | 'agent';
export type PingStatus = 'online' | 'inactive' | 'offline' | 'unknown';
export type SshAuthType = 'key' | 'password';

export type NodeProtocol =
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'hysteria'
  | 'socks'
  | 'http'
  | 'tunnel'
  | 'tuic'
  | 'shadowtls'
  | 'naive';

export type NodeTemplate =
  | 'vless-reality'
  | 'vmess-ws-tls'
  | 'trojan-tls'
  | 'ss2022'
  | 'hysteria'
  | 'socks'
  | 'http'
  | 'tunnel'
  | 'tuic'
  | 'shadowtls'
  | 'naive';

export type TlsMode = 'none' | 'reality' | 'tls' | 'shadowtls';
export type OutboundType = 'direct' | 'relay';
export type Transport = 'raw' | 'ws' | 'tcp';

export type XrayNodeProtocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'socks' | 'http';

export type XrayNodeTemplate =
  | 'xray-vless-reality'
  | 'xray-vmess-ws-tls'
  | 'xray-trojan-tls'
  | 'xray-ss'
  | 'xray-socks'
  | 'xray-http';

export type XrayTlsMode = 'none' | 'reality' | 'tls';

export type ForwardMechanism = 'iptables' | 'socat';

// ---------- 服务器 ----------

export interface Server {
  id: number;
  name: string;
  role: ServerRole;
  control: ControlMode;
  host: string;
  /** 对外地址(客户端/机器间连接用;SSH 目标用 host)。留空 = 同 host */
  client_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_type: SshAuthType;
  /** 1 = 命令经 sudo -n 执行(甲骨文等仅给普通用户的机器) */
  ssh_sudo: number;
  region: string;
  ping_status: PingStatus;
  singbox_version: string;
  xray_version: string;
  xray_ping_status: PingStatus;
  xray_last_seen: string | null;
  last_seen: string | null;
  /** SSH 跳板机(经它隧道连接,解决本地无 IPv6/直连不稳) */
  jump_server_id: number | null;
}

export interface ServerInput {
  name: string;
  role: ServerRole;
  control: ControlMode;
  region?: string;
  /** control='ssh' 时必填 */
  host?: string;
  /** 对外地址,留空 = 用 host */
  clientHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: SshAuthType;
  /** 编辑时留空 = 不修改凭据 */
  sshAuthSecret?: string;
  sshSudo?: boolean;
  /** SSH 跳板机(经它隧道连接) */
  jumpServerId?: number | null;
}

export interface TestResult {
  ok: boolean;
  message?: string;
}

// ---------- SingBox 节点 ----------

export interface NodeItem {
  id: number;
  name: string;
  server_id: number;
  server_name: string;
  protocol: NodeProtocol;
  listen_port: number;
  enabled: 0 | 1;
  tls_mode: TlsMode;
  transport: Transport;
  /** Reality 借站域名(公开非机密) */
  sni?: string;
  tunnel_address?: string;
  tunnel_port?: number;
  /** socks/http 认证凭据(编辑需回显;其余协议不回显) */
  auth_user?: string;
  auth_password?: string;
  outbound_type: OutboundType;
  landing_server_id?: number;
  landing_name?: string;
  share_link: string | null;
  note: string;
  created_at: string;
}

export interface NodeCreateInput {
  template: NodeTemplate;
  name: string;
  serverId: number;
  outboundType?: OutboundType;
  landingServerId?: number;
  /** 仅 vless-reality / shadowtls 模板使用 */
  sni?: string;
  /** 留空自动分配(后端保证同机唯一) */
  port?: number;
  tunnelAddress?: string;
  tunnelPort?: number;
  authUser?: string;
  authPassword?: string;
}

export interface NodePatch {
  name?: string;
  note?: string;
  enabled?: boolean;
  port?: number;
  /** 改协议 = 凭据自动重新生成,客户端需更新 */
  protocol?: NodeProtocol;
  outboundType?: OutboundType;
  landingServerId?: number;
  sni?: string;
  tunnelAddress?: string;
  tunnelPort?: number;
  authUser?: string;
  authPassword?: string;
}

// ---------- Xray 节点 ----------

export interface XrayNodeItem {
  id: number;
  name: string;
  server_id: number;
  server_name: string;
  protocol: XrayNodeProtocol;
  listen_port: number;
  enabled: 0 | 1;
  tls_mode: XrayTlsMode;
  transport: Transport;
  sni?: string;
  ws_path?: string;
  flow?: string;
  outbound_type: OutboundType;
  landing_server_id?: number;
  landing_name?: string;
  share_link: string | null;
  note: string;
  created_at: string;
}

export interface XrayNodeCreateInput {
  template: XrayNodeTemplate;
  name: string;
  serverId: number;
  sni?: string;
  /** 默认 xtls-rprx-vision(仅 vless) */
  flow?: string;
  port?: number;
  outboundType?: OutboundType;
  landingServerId?: number;
}

export interface XrayNodePatch {
  name?: string;
  note?: string;
  enabled?: boolean;
  port?: number;
  protocol?: XrayNodeProtocol;
  sni?: string;
  flow?: string;
  outboundType?: OutboundType;
  landingServerId?: number;
}

// ---------- 节点测速 ----------

export interface NodeTestResult {
  ok: boolean;
  latency_ms?: number;
  detail: string;
}

// ---------- SNI 域名库 ----------

export interface SniItem {
  id: number;
  domain: string;
  note: string;
  /** 内置大厂域名,可编辑可删除 */
  builtin: number;
}

// ---------- 设置 ----------

export interface Settings {
  subSlug: string;
  subUrl: string;
  /** 订阅里 Reality 节点地址:true=IP(绕开慢 DNS) / false=域名 */
  singboxRealityIp: boolean;
  xrayRealityIp: boolean;
}

// ---------- 中转规则(端口转发) ----------

export interface PortForwardItem {
  id: number;
  name: string;
  entry_server_id: number;
  entry_server_name: string;
  landing_server_id: number;
  landing_server_name: string;
  target_node_type: 'singbox' | 'xray';
  target_node_id: number;
  target_node_name: string;
  entry_port: number;
  target_port: number;
  mechanism: ForwardMechanism;
  enabled: number;
  /** 1 = 该中转线路进入订阅(入口机地址+入口端口+落地节点参数) */
  include_in_sub: number;
  note: string;
  created_at: string;
}

export interface PortForwardCreateInput {
  name: string;
  entryServerId: number;
  landingServerId: number;
  targetNodeType: 'singbox' | 'xray';
  targetNodeId: number;
  /** 留空自动分配 */
  entryPort?: number;
  targetPort: number;
  /** iptables 不可用(如无 NET_ADMIN / NAT 模块)时才选 socat */
  mechanism: ForwardMechanism;
  note?: string;
}

// ---------- 一键部署 ----------

export interface CoreDeployResult {
  ok: boolean;
  error?: string;
  steps: string[];
  journal?: string;
  skipped?: boolean;
}

export interface DeployAllResult {
  serverId: number;
  serverName: string;
  singbox: CoreDeployResult;
  xray: CoreDeployResult;
}

// ---------- 认证 ----------

export interface LoginResult {
  token: string;
  username: string;
}

export interface AccountPatch {
  username?: string;
  oldPassword: string;
  newPassword?: string;
}
