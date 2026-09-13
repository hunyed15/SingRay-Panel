// Deploy orchestration (design.md §3): collect machine data → render config
// (pure configgen) → ensure certs → transactional deployCore. deployAll runs
// machines with concurrency ≤3. Ported from singbox-panel deployServices.js +
// deployXrayServices.js semantics (lazy reality keypair / landing port / certs).

import type { DatabaseSync } from 'node:sqlite';
import { buildMachineConfig } from '../core/configgen/singbox/index.js';
import { buildXrayConfig } from '../core/configgen/xray/index.js';
import { genSelfSignedCert } from '../core/configgen/cert.js';
import type { MachineCtx } from '../core/configgen/types.js';
import { deployCore } from '../core/deploy/index.js';
import { exec, writeFile } from '../core/ssh/executor.js';
import { rowConn } from './conn.js';
import type { SshConn } from '../core/ssh/executor.js';
import { decrypt, encrypt, genRealityKeypair, genShortId, genSsPassword } from '../core/crypto.js';
import { serverLifecycle } from './lifecycle.js';
import { hasRealCert, certPaths } from '../core/certs/acme.js';
import { config } from '../config.js';

const secret = () => config.appSecret; // 字段加密密钥(迁移须等于旧 APP_SECRET)

export interface MachineDeployResult {
  serverId: number;
  serverName: string;
  singbox: { ok: boolean; error?: string; steps: string[]; journal?: string; skipped?: boolean };
  xray: { ok: boolean; error?: string; steps: string[]; journal?: string; skipped?: boolean };
}

type Row = Record<string, any>;

function collectMachineData(db: DatabaseSync, machineId: number) {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(machineId) as Row | undefined;
  if (!row) throw new Error(`server ${machineId} not found`);

  let relaySettings: { realityPrivateKey: string; shortId: string } | null = null;
  let landingSettings: { in_port: number; method: string; password: string } | null = null;
  if (row.role === 'relay') {
    const rs = db.prepare('SELECT * FROM relay_settings WHERE server_id = ?').get(machineId) as Row | undefined;
    if (rs) relaySettings = { realityPrivateKey: decrypt(secret(), rs.reality_private_key), shortId: rs.short_id };
  } else if (row.role === 'landing') {
    const ls = db.prepare('SELECT * FROM landing_settings WHERE server_id = ?').get(machineId) as Row | undefined;
    if (ls) landingSettings = { in_port: ls.in_port, method: ls.method, password: decrypt(secret(), ls.password) };
  }

  // 落地机等也可能直连 vless-reality 节点 → 懒生成 Reality 密钥并持久化
  if (!relaySettings) {
    const hasReality = (db.prepare("SELECT COUNT(*) c FROM nodes WHERE server_id = ? AND protocol = 'vless' AND enabled = 1").get(machineId) as { c: number }).c;
    if (hasReality > 0) {
      const { publicKey, privateKey } = genRealityKeypair();
      const shortId = genShortId();
      db.prepare('INSERT OR REPLACE INTO relay_settings (server_id, reality_public_key, reality_private_key, short_id, port_base) VALUES (?,?,?,?,31000)').run(machineId, publicKey, encrypt(secret(), privateKey), shortId);
      relaySettings = { realityPrivateKey: privateKey, shortId };
    }
  }

  const nodes = (db.prepare('SELECT * FROM nodes WHERE server_id = ?').all(machineId) as Row[]).map((n) => ({
    id: n.id, name: n.name, server_id: n.server_id, protocol: n.protocol, listen_port: n.listen_port,
    enabled: n.enabled, creds: JSON.parse(decrypt(secret(), n.creds_enc)), tls_mode: n.tls_mode, sni: n.sni,
    transport: n.transport, ws_path: n.ws_path, outbound_type: n.outbound_type, landing_server_id: n.landing_server_id,
    tunnel_address: n.tunnel_address, tunnel_port: n.tunnel_port, note: n.note,
  }));

  const landings: Record<number, { host: string; in_port: number; method: string; password: string }> = {};
  const landingIds = [...new Set(nodes.map((n) => n.landing_server_id).filter(Boolean))];
  for (const id of landingIds) {
    const ls = db.prepare('SELECT * FROM landing_settings WHERE server_id = ?').get(id) as Row | undefined;
    const srv = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(id) as Row | undefined;
    if (ls && srv) landings[id] = { host: srv.client_host || srv.host, in_port: ls.in_port, method: ls.method, password: decrypt(secret(), ls.password) };
  }

  const machine: MachineCtx & { id: number } = {
    id: row.id,
    name: row.name,
    host: row.client_host || row.host,
    role: row.role,
    certPath: `/etc/sing-box/tls/${row.name}.crt`,
    keyPath: `/etc/sing-box/tls/${row.name}.key`,
    realityPrivateKey: relaySettings?.realityPrivateKey,
    shortId: relaySettings?.shortId,
  };

  return { row, machine, landingSettings, nodes, landings };
}

function collectXrayMachineData(db: DatabaseSync, machineId: number) {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(machineId) as Row | undefined;
  if (!row) throw new Error(`server ${machineId} not found`);

  // Xray Reality 密钥(懒生成;已有记录则解密)
  let xs = db.prepare('SELECT * FROM xray_server_settings WHERE server_id = ?').get(machineId) as Row | undefined;
  if (!xs) {
    const hasReality = (db.prepare("SELECT COUNT(*) c FROM xray_nodes WHERE server_id = ? AND protocol = 'vless' AND enabled = 1").get(machineId) as { c: number }).c;
    if (hasReality > 0) {
      const { publicKey, privateKey } = genRealityKeypair();
      const shortId = genShortId();
      db.prepare('INSERT OR REPLACE INTO xray_server_settings (server_id, reality_public_key, reality_private_key, short_id, port_base) VALUES (?,?,?,?,41000)').run(machineId, publicKey, encrypt(secret(), privateKey), shortId);
      xs = { reality_private_key: privateKey, short_id: shortId };
    }
  } else if (xs.reality_private_key) {
    xs = { ...xs, reality_private_key: decrypt(secret(), xs.reality_private_key) };
  }

  const nodes = (db.prepare('SELECT * FROM xray_nodes WHERE server_id = ?').all(machineId) as Row[]).map((n) => ({
    id: n.id, name: n.name, server_id: n.server_id, protocol: n.protocol, listen_port: n.listen_port,
    enabled: n.enabled, creds: JSON.parse(decrypt(secret(), n.creds_enc)), tls_mode: n.tls_mode, sni: n.sni,
    transport: n.transport, ws_path: n.ws_path, flow: n.flow, outbound_type: n.outbound_type,
    landing_server_id: n.landing_server_id, note: n.note,
  }));

  const landings: Record<number, { host: string; in_port: number; method: string; password: string }> = {};
  const landingIds = [...new Set(nodes.map((n) => n.landing_server_id).filter(Boolean))];
  for (const id of landingIds) {
    const srv = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(id) as Row | undefined;
    const xls = db.prepare('SELECT * FROM xray_server_settings WHERE server_id = ?').get(id) as Row | undefined;
    if (xls?.in_port && srv) {
      landings[id] = { host: srv.client_host || srv.host, in_port: xls.in_port, method: xls.in_method || 'aes-128-gcm', password: decrypt(secret(), xls.in_password_enc) };
    }
  }

  // Xray 落地机独立 ss 入站(与 sing-box 分开端口,懒生成)
  let xrayLandingSettings: { in_port: number; in_method: string; in_password: string } | null = null;
  if (row.role === 'landing') {
    const hasRelayRef = ((db.prepare("SELECT COUNT(*) c FROM xray_nodes WHERE landing_server_id = ? AND enabled = 1 AND outbound_type = 'relay'").get(machineId)) as { c: number }).c > 0;
    if (hasRelayRef) {
      if (xs?.in_port) {
        xrayLandingSettings = { in_port: xs.in_port, in_method: xs.in_method || 'aes-128-gcm', in_password: decrypt(secret(), xs.in_password_enc) };
      } else {
        const portBase = xs?.port_base || 41000;
        let port = portBase + machineId;
        const sbPort = db.prepare('SELECT in_port FROM landing_settings WHERE server_id = ?').get(machineId) as { in_port: number } | undefined;
        if (sbPort && sbPort.in_port === port) port += 100;
        const password = genSsPassword();
        const enc = encrypt(secret(), password);
        if (xs) {
          db.prepare('UPDATE xray_server_settings SET in_port=?, in_method=?, in_password_enc=? WHERE server_id=?').run(port, 'aes-128-gcm', enc, machineId);
        } else {
          db.prepare('INSERT OR REPLACE INTO xray_server_settings (server_id, reality_public_key, reality_private_key, short_id, port_base, in_port, in_method, in_password_enc) VALUES (?,?,?,?,?,?,?,?)').run(machineId, '', '', '', 41000, port, 'aes-128-gcm', enc);
        }
        xrayLandingSettings = { in_port: port, in_method: 'aes-128-gcm', in_password: password };
      }
    }
  }

  const machine: MachineCtx & { id: number } = {
    id: row.id,
    name: row.name,
    host: row.client_host || row.host,
    role: row.role,
    certPath: `/etc/sing-box/tls/${row.name}.crt`,
    keyPath: `/etc/sing-box/tls/${row.name}.key`,
    realityPrivateKey: (xs as Row | undefined)?.reality_private_key,
    shortId: (xs as Row | undefined)?.short_id,
  };

  return { row, machine, nodes, landings, xrayLandingSettings };
}

async function ensureCerts(
  conn: SshConn,
  machine: MachineCtx,
  nodes: { tls_mode: string }[],
  inject?: { execFn?: typeof exec; writeFileFn?: typeof writeFile },
): Promise<string[]> {
  if (!nodes.some((n) => n.tls_mode === 'tls')) return [];
  const execFn = inject?.execFn ?? exec;
  const writeFileFn = inject?.writeFileFn ?? writeFile;
  // 真证书(ACME)已装 → 直接用,不再生成自签(新版 Xray 已移除 allowInsecure,自签在客户端不可用)
  if (machine.certPath?.startsWith('/etc/singray/certs/')) return ['cert(acme)'];
  const { certPem, keyPem } = genSelfSignedCert({ commonName: machine.name, altNames: [machine.name, machine.host] });
  await execFn(conn, 'mkdir -p /etc/sing-box/tls', { timeoutClass: 'quick' });
  await writeFileFn(conn, machine.certPath!, certPem, execFn);
  await writeFileFn(conn, machine.keyPath!, keyPem, execFn);
  return ['cert(self-signed)'];
}

/** 单机双核心下发。execFn/writeFileFn 可注入供测试。 */
export async function deployServerBothCores(
  db: DatabaseSync,
  serverId: number,
  inject?: { execFn?: typeof exec; writeFileFn?: typeof writeFile },
  /** 只部署其中一个核心(单机按核心下发);缺省两个都部署 */
  only?: 'singbox' | 'xray',
): Promise<MachineDeployResult> {
  const sbRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!sbRow) throw new Error(`server ${serverId} not found`);
  const base: MachineDeployResult = {
    serverId,
    serverName: sbRow.name,
    singbox: { ok: true, steps: [] },
    xray: { ok: true, steps: [] },
  };
  if (sbRow.control !== 'ssh') {
    base.singbox = { ok: false, error: 'agent 模式暂不支持下发(V1 仅 SSH)', steps: [] };
    base.xray = { ok: false, error: 'agent 模式暂不支持下发', steps: [] };
    return base;
  }
  const conn = rowConn(db, sbRow);

  // sing-box
  const sbData = collectMachineData(db, serverId);
  if ((!only || only === 'singbox') && (sbData.nodes.some((n) => n.enabled === 1) || sbData.row.role === 'landing')) {
    try {
      // 部署前置:机器缺核心二进制时自动先安装(部署=配置下发,前提是核心已装)
      const sbExec = inject?.execFn ?? exec;
      // 真证书优先: 机器上有 ACME 证书(client_host 域名) → certPath 指向它
      const sbDomain = sbData.row.client_host || sbData.row.host;
      if (await hasRealCert(conn, sbDomain, sbExec)) {
        const p = certPaths(sbDomain);
        sbData.machine.certPath = p.fullchain;
        sbData.machine.keyPath = p.key;
      }
      let sbAutoInstall = false;
      try {
        await sbExec(conn, 'test -x /usr/local/bin/sing-box', { timeoutClass: 'quick' });
      } catch {
        await serverLifecycle(db, serverId, 'singbox', 'install', inject);
        sbAutoInstall = true;
      }
      const certSteps = await ensureCerts(conn, sbData.machine, sbData.nodes, inject);
      const cfg = buildMachineConfig({ machine: sbData.machine, landingSettings: sbData.landingSettings ?? undefined, nodes: sbData.nodes, landings: sbData.landings });
      const r = await deployCore(conn, { core: 'singbox', config: cfg, execFn: inject?.execFn, writeFileFn: inject?.writeFileFn });
      base.singbox = { ok: r.ok, error: r.error, steps: [...(sbAutoInstall ? ['auto-install'] : []), ...certSteps, ...r.steps.map((s) => s.step + (s.ok ? '' : '(fail)'))], journal: r.journal };
    } catch (err) {
      base.singbox = { ok: false, error: (err as Error).message, steps: [] };
    }
  }

  if (only === 'xray') base.singbox = { ok: true, steps: ['skip'], skipped: true };

  // xray
  const xrData = collectXrayMachineData(db, serverId);
  const hasXrayActive = only === 'singbox' ? false : xrData.nodes.some((n) => n.enabled === 1);
  const isLandingRef = ((db.prepare("SELECT COUNT(*) c FROM xray_nodes WHERE landing_server_id = ? AND enabled = 1 AND outbound_type = 'relay'").get(serverId)) as { c: number }).c > 0;
  if (hasXrayActive || isLandingRef) {
    try {
      const xrExec = inject?.execFn ?? exec;
      const xrDomain = xrData.row.client_host || xrData.row.host;
      if (await hasRealCert(conn, xrDomain, xrExec)) {
        const p = certPaths(xrDomain);
        xrData.machine.certPath = p.fullchain;
        xrData.machine.keyPath = p.key;
      }
      let xrAutoInstall = false;
      try {
        await xrExec(conn, 'test -x /usr/local/bin/xray', { timeoutClass: 'quick' });
      } catch {
        await serverLifecycle(db, serverId, 'xray', 'install', inject);
        xrAutoInstall = true;
      }
      const certSteps = await ensureCerts(conn, xrData.machine, xrData.nodes, inject);
      const cfg = buildXrayConfig({ machine: xrData.machine, nodes: xrData.nodes, landings: xrData.landings, xrayLandingSettings: xrData.xrayLandingSettings ?? undefined });
      const r = await deployCore(conn, { core: 'xray', config: cfg, execFn: inject?.execFn, writeFileFn: inject?.writeFileFn });
      base.xray = { ok: r.ok, error: r.error, steps: [...(xrAutoInstall ? ['auto-install'] : []), ...certSteps, ...r.steps.map((s) => s.step + (s.ok ? '' : '(fail)'))], journal: r.journal };
    } catch (err) {
      base.xray = { ok: false, error: (err as Error).message, steps: [] };
    }
  } else {
    base.xray = { ok: true, steps: ['skip'], skipped: true };
  }

  return base;
}

/** 部署全部:所有 ssh 机器,并发 ≤3(前序 design.md §2) */
export async function deployAll(db: DatabaseSync, inject?: Parameters<typeof deployServerBothCores>[2]): Promise<MachineDeployResult[]> {
  const servers = db.prepare("SELECT id, name FROM servers WHERE control = 'ssh' ORDER BY id").all() as Row[];
  const results: MachineDeployResult[] = new Array(servers.length);
  let cursor = 0;
  async function worker() {
    while (cursor < servers.length) {
      const idx = cursor++;
      const s = servers[idx];
      try {
        results[idx] = await deployServerBothCores(db, s.id, inject);
      } catch (err) {
        results[idx] = {
          serverId: s.id, serverName: s.name,
          singbox: { ok: false, error: (err as Error).message, steps: [] },
          xray: { ok: false, error: (err as Error).message, steps: [] },
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, servers.length) }, worker));
  return results;
}
