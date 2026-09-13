import type { BadgeProps } from 'antd';
import type {
  ControlMode,
  ForwardMechanism,
  NodeProtocol,
  PingStatus,
  ServerRole,
  XrayNodeProtocol,
} from '../services/types';

/**
 * 枚举 → 展示文案/颜色 单一来源,页面禁止各自为政。
 * 颜色只使用 antd 预设语义色/预设色。
 */
export type StatusPreset = NonNullable<BadgeProps['status']>;

export const SERVER_STATUS_META: Record<PingStatus, { status: StatusPreset; text: string }> = {
  online: { status: 'success', text: '在线' },
  inactive: { status: 'default', text: '未激活' },
  offline: { status: 'error', text: '离线' },
  unknown: { status: 'default', text: '未知' },
};

export const ROLE_META: Record<ServerRole, { text: string; tagColor: 'blue' | 'green' }> = {
  relay: { text: '中转机', tagColor: 'blue' },
  landing: { text: '落地机', tagColor: 'green' },
};

export const CONTROL_META: Record<ControlMode, { text: string; tagColor: 'default' | 'purple' }> = {
  ssh: { text: 'SSH', tagColor: 'default' },
  agent: { text: 'Agent', tagColor: 'purple' },
};

export const PROTOCOL_META: Record<NodeProtocol, { text: string; tagColor: string }> = {
  vless: { text: 'VLESS', tagColor: 'blue' },
  vmess: { text: 'VMess', tagColor: 'geekblue' },
  trojan: { text: 'Trojan', tagColor: 'purple' },
  shadowsocks: { text: 'SS-2022', tagColor: 'green' },
  hysteria: { text: 'Hysteria2', tagColor: 'volcano' },
  socks: { text: 'SOCKS', tagColor: 'orange' },
  http: { text: 'HTTP', tagColor: 'gold' },
  tunnel: { text: '隧道', tagColor: 'cyan' },
  tuic: { text: 'TUIC', tagColor: 'magenta' },
  shadowtls: { text: 'ShadowTLS', tagColor: 'lime' },
  naive: { text: 'Naive', tagColor: 'pink' },
};

export const XRAY_PROTOCOL_META: Record<XrayNodeProtocol, { text: string; tagColor: string }> = {
  vless: { text: 'VLESS', tagColor: 'blue' },
  vmess: { text: 'VMess', tagColor: 'geekblue' },
  trojan: { text: 'Trojan', tagColor: 'purple' },
  shadowsocks: { text: 'SS', tagColor: 'green' },
  socks: { text: 'SOCKS', tagColor: 'orange' },
  http: { text: 'HTTP', tagColor: 'gold' },
};

export const MECHANISM_META: Record<ForwardMechanism, { text: string; tagColor: string }> = {
  iptables: { text: 'iptables', tagColor: 'green' },
  socat: { text: 'socat', tagColor: 'orange' },
};

/** 节点「在线」为前端派生:启用 且 入口机探测在线 */
export function isNodeOnline(
  node: { enabled: number; server_id: number },
  onlineServerIds: ReadonlySet<number>,
): boolean {
  return node.enabled === 1 && onlineServerIds.has(node.server_id);
}
