// Subscription conversion: share links (base64) + sing-box client config,
// UA/format dispatch. Ported from singbox-panel sub.js + xray_sub.js.
// Content = enabled non-tunnel nodes; self-signed TLS outbound uses insecure.

export interface NodeView {
  id: number;
  name: string;
  protocol: string;
  /** 对外地址(reality 节点按订阅设置用 IP 或域名,由收集层决策) */
  host: string;
  port: number;
  sni: string;
  ws_path: string;
  realityPublicKey: string | null;
  shortId: string | null;
  creds: Record<string, any>;
}

const SINGBOX_UA = /sing-box|singbox|\bSFI\b|\bSFA\b|\bSFM\b/i;

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pickFormat(query: Record<string, unknown>, ua?: string): 'base64' | 'singbox' {
  if (query.format === 'base64' || query.format === 'singbox') return query.format;
  return SINGBOX_UA.test(ua || '') ? 'singbox' : 'base64';
}

export function buildShareLink(view: NodeView): string | null {
  const enc = encodeURIComponent(view.name);
  const { host, port, sni } = view;
  const c = view.creds;
  switch (view.protocol) {
    case 'vless': {
      const flowParam = c.flow ? `&flow=${c.flow}` : '';
      return (
        `vless://${c.uuid}@${host}:${port}?encryption=none&security=reality&sni=${sni}` +
        `&fp=chrome&pbk=${view.realityPublicKey}&sid=${view.shortId}&type=tcp${flowParam}#${enc}`
      );
    }
    case 'vmess': {
      const vmess = {
        v: '2',
        ps: view.name,
        add: host,
        port,
        id: c.uuid,
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host,
        path: view.ws_path,
        tls: 'tls',
        sni,
        allowInsecure: '1',
      };
      return `vmess://${b64url(JSON.stringify(vmess))}`;
    }
    case 'trojan':
      return `trojan://${encodeURIComponent(c.password)}@${host}:${port}?security=tls&sni=${sni}&allowInsecure=1#${enc}`;
    case 'shadowsocks':
      return `ss://${b64url(`${c.method}:${c.password}`)}@${host}:${port}#${enc}`;
    case 'hysteria':
      return `hysteria2://${encodeURIComponent(c.password)}@${host}:${port}?sni=${sni}&insecure=1#${enc}`;
    case 'tuic':
      return `tuic://${c.uuid}:${encodeURIComponent(c.password)}@${host}:${port}?congestion_control=bbr&sni=${sni}&allow_insecure=1#${enc}`;
    case 'socks':
    case 'http':
    case 'shadowtls':
    case 'naive':
    case 'tunnel':
      return null;
    default:
      return null;
  }
}

export function toBase64(views: NodeView[]): string {
  const lines = views.map(buildShareLink).filter(Boolean);
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

function tlsInsecure(serverName: string) {
  return { enabled: true, server_name: serverName, insecure: true };
}

function buildClientOutbound(view: NodeView): Record<string, unknown> | null {
  const { host, port, sni, ws_path } = view;
  const c = view.creds;
  const tag = view.name;
  switch (view.protocol) {
    case 'vless':
      return {
        type: 'vless',
        tag,
        server: host,
        server_port: port,
        uuid: c.uuid,
        // 不带 flow:实测 vision+reality 在此版本线不兼容
        tls: {
          enabled: true,
          server_name: sni,
          utls: { enabled: true, fingerprint: 'chrome' },
          reality: { enabled: true, public_key: view.realityPublicKey, short_id: view.shortId },
        },
      };
    case 'vmess':
      return {
        type: 'vmess',
        tag,
        server: host,
        server_port: port,
        uuid: c.uuid,
        tls: tlsInsecure(host),
        transport: { type: 'ws', path: ws_path },
      };
    case 'trojan':
      return { type: 'trojan', tag, server: host, server_port: port, password: c.password, tls: tlsInsecure(host) };
    case 'shadowsocks':
      return { type: 'shadowsocks', tag, server: host, server_port: port, method: c.method, password: c.password };
    case 'hysteria':
      return { type: 'hysteria2', tag, server: host, server_port: port, password: c.password, tls: tlsInsecure(host) };
    case 'tuic':
      return {
        type: 'tuic',
        tag,
        server: host,
        server_port: port,
        uuid: c.uuid,
        password: c.password,
        congestion_control: 'bbr',
        tls: tlsInsecure(host),
      };
    case 'shadowtls':
      return { type: 'shadowtls', tag, server: host, server_port: port, version: 3, password: c.password, tls: { enabled: true, server_name: sni } };
    case 'naive':
      return { type: 'naive', tag, server: host, server_port: port, username: c.username, password: c.password, tls: tlsInsecure(host) };
    case 'socks':
      return c.username
        ? { type: 'socks', tag, server: host, server_port: port, username: c.username, password: c.password }
        : { type: 'socks', tag, server: host, server_port: port };
    case 'http':
      return c.username
        ? { type: 'http', tag, server: host, server_port: port, username: c.username, password: c.password }
        : { type: 'http', tag, server: host, server_port: port };
    case 'tunnel':
      return null;
    default:
      return null;
  }
}

export function toSingboxConfig(views: NodeView[]): Record<string, unknown> {
  const outbounds = views.map(buildClientOutbound).filter((o): o is Record<string, unknown> => o !== null);
  const selector = { type: 'selector', tag: 'auto', outbounds: outbounds.map((o) => o.tag) };
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds: [...outbounds, selector, { type: 'direct', tag: 'direct' }],
    route: { final: 'auto' },
  };
}
