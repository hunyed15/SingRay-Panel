// Clash/mihomo 订阅生成:NodeView → Clash YAML(mihomo 兼容)。
// 零依赖手写序列化:JSON 字符串即合法 YAML 双引号标量,密码/特殊字符安全。

import type { NodeView } from './index.js';

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

function scalar(v: YamlValue): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return JSON.stringify(String(v)); // JSON 字符串 = 合法 YAML 双引号标量
}

function emit(value: YamlValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item);
          const [firstKey, firstVal] = entries[0];
          const rest = entries.slice(1).map(([k, v]) => {
            if (v !== null && typeof v === 'object') return `${pad}  ${k}:\n${emit(v, indent + 2)}`;
            return `${pad}  ${k}: ${scalar(v as YamlValue)}`;
          });
          return [`${pad}- ${firstKey}: ${scalar(firstVal as YamlValue)}`, ...rest].filter(Boolean).join('\n');
        }
        return `${pad}- ${scalar(item as YamlValue)}`;
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) return `${pad}${k}:\n${emit(v, indent + 1)}`;
        if (Array.isArray(v)) {
          if (v.every((i) => typeof i !== 'object' || i === null)) return `${pad}${k}: [${v.map((i) => scalar(i as YamlValue)).join(', ')}]`;
          return `${pad}${k}:\n${emit(v, indent + 1)}`;
        }
        return `${pad}${k}: ${scalar(v as YamlValue)}`;
      })
      .join('\n');
  }
  return pad + scalar(value);
}

/** 单节点 → mihomo proxy 对象;不支持的协议返回 null(naive/tunnel/shadowtls 复杂底层跳过) */
export function clashProxy(v: NodeView): Record<string, YamlValue> | null {
  const c = v.creds;
  const base = { name: v.name, server: v.host, port: v.port };
  switch (v.protocol) {
    case 'vless': {
      const p: Record<string, YamlValue> = {
        ...base,
        type: 'vless',
        uuid: c.uuid,
        udp: true,
        tls: true,
        'client-fingerprint': 'chrome',
        servername: v.sni,
      };
      if (c.flow) p.flow = c.flow;
      if (v.realityPublicKey) {
        p['reality-opts'] = { 'public-key': v.realityPublicKey, 'short-id': v.shortId ?? '' };
      } else {
        p['skip-cert-verify'] = true;
      }
      if (v.protocol === 'vless' && v.ws_path) {
        p.network = 'ws';
        p['ws-opts'] = { path: v.ws_path };
      }
      return p;
    }
    case 'vmess':
      return {
        ...base,
        type: 'vmess',
        uuid: c.uuid,
        alterId: 0,
        cipher: 'auto',
        udp: true,
        tls: true,
        servername: v.sni,
        'skip-cert-verify': true,
        network: 'ws',
        'ws-opts': { path: v.ws_path || '/' },
      };
    case 'trojan':
      return { ...base, type: 'trojan', password: c.password, udp: true, sni: v.sni, 'skip-cert-verify': true };
    case 'shadowsocks':
      return { ...base, type: 'ss', cipher: c.method, password: c.password, udp: true };
    case 'hysteria2':
      return { ...base, type: 'hysteria2', password: c.password, sni: v.sni, 'skip-cert-verify': true };
    case 'tuic':
      return { ...base, type: 'tuic', uuid: c.uuid, password: c.password, sni: v.sni, 'congestion-controller': 'bbr', 'skip-cert-verify': true, udp: true };
    case 'socks':
      return c.username
        ? { ...base, type: 'socks5', username: c.username, password: c.password, udp: true }
        : { ...base, type: 'socks5', udp: true };
    case 'http':
      return c.username
        ? { ...base, type: 'http', username: c.username, password: c.password }
        : { ...base, type: 'http' };
    default:
      return null; // naive/shadowtls/tunnel
  }
}

/** 全量 Clash/mihomo 订阅(两核心合并,与通用订阅同一节点集合) */
export function toClashYaml(views: NodeView[]): string {
  const proxies = views.map(clashProxy).filter((p): p is Record<string, YamlValue> => p !== null);
  const names = proxies.map((p) => p.name as string);
  const config: YamlValue = {
    port: 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    proxies,
    'proxy-groups': [
      { name: 'PROXY', type: 'select', proxies: [...names, 'AUTO'] },
      { name: 'AUTO', type: 'url-test', proxies: names, url: 'http://www.gstatic.com/generate_204', interval: 300 },
    ],
    rules: ['MATCH,PROXY'],
  };
  return emit(config) + '\n';
}
