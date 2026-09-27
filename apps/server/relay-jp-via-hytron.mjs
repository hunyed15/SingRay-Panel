// Ali-CDT → Hytron(socat) → JP-2.99 两跳中转
// 1) Hytron 上建中转规则:入口端口 → JP-2.99:节点端口(socat 自动处理 IPv6 目标)
// 2) Ali-CDT 上建中转规则:入口端口 → Hytron:上一步的入口端口(进订阅)
import crypto from 'node:crypto';
import net from 'node:net';

const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');

const api = async (path, method = 'GET', body) => {
  const res = await fetch('http://127.0.0.1:3000' + path, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const tcp = (host, port, ms = 10000) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.removeAllListeners(); s.destroy(); res(r); };
  s.setTimeout(ms, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

const servers = (await api('/api/servers')).data;
const hytron = servers.find((s) => s.name === 'Hytron');
const cdt = servers.find((s) => s.name === 'Ali-CDT');
const jp = servers.find((s) => s.name === 'JP-2.99');

const sbNodes = (await api('/api/nodes')).data.filter((n) => n.server_id === jp.id && n.protocol !== 'socks' && n.protocol !== 'http');
const xrNodes = (await api('/api/xray/nodes')).data.filter((n) => n.server_id === jp.id && n.protocol !== 'socks' && n.protocol !== 'http');
const targets = [...sbNodes, ...xrNodes];
console.log(`编排: Ali-CDT → Hytron → JP-2.99 (${targets.length} 个节点)`);

const existing = (await api('/api/port-forwards')).data;

// ---- 1) Hytron → JP ----
console.log('\n== 1. Hytron → JP-2.99 ==');
const hytronPorts = {};
for (const t of targets) {
  const short = t.name.replace(/^JP-2\.99-/, '');
  const pfName = `Hytron→${t.name}`;
  const ex = existing.find((f) => f.name === pfName);
  if (ex) { hytronPorts[short] = ex.entry_port; console.log(`  SKIP ${pfName} (${ex.entry_port})`); continue; }
  const r = await api('/api/port-forwards', 'POST', {
    name: pfName, entryServerId: hytron.id, landingServerId: jp.id,
    targetNodeType: sbNodes.includes(t) ? 'singbox' : 'xray',
    targetNodeId: t.id, targetPort: t.listen_port, mechanism: 'socat', note: '两跳:CDT→Hytron→JP',
  });
  if (r.data?.port_forward) {
    hytronPorts[short] = r.data.port_forward.entry_port;
    console.log(`  ✅ ${pfName} (Hytron:${r.data.port_forward.entry_port} → JP:${t.listen_port})`);
  } else console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 100)}`);
}

// ---- 2) 验证 Hytron → JP ----
console.log('\n== 2. 验证 Hytron 入口端口可达 ==');
for (const t of targets) {
  const short = t.name.replace(/^JP-2\.99-/, '');
  const p = hytronPorts[short];
  if (!p) continue;
  console.log(`  ${await tcp('hytron.1o1.top', p) ? '✅' : '❌'} ${short} :${p}`);
}

// ---- 3) Ali-CDT → Hytron ----
console.log('\n== 3. Ali-CDT → Hytron ==');
const existing2 = (await api('/api/port-forwards')).data;
for (const t of targets) {
  const short = t.name.replace(/^JP-2\.99-/, '');
  const hPort = hytronPorts[short];
  if (!hPort) { console.log(`  SKIP ${short}(无 Hytron 端口)`); continue; }
  const pfName = `Ali-CDT→Hytron→${short}`;
  if (existing2.some((f) => f.name === pfName)) { console.log(`  SKIP ${pfName}(已有)`); continue; }
  const r = await api('/api/port-forwards', 'POST', {
    name: pfName, entryServerId: cdt.id, landingServerId: hytron.id,
    targetNodeType: 'singbox', targetNodeId: (await api('/api/nodes')).data.find((n) => n.server_id === hytron.id)?.id ?? 1,
    targetPort: hPort, mechanism: 'socat', note: '两跳:CDT→Hytron→JP',
  });
  if (r.data?.port_forward) {
    await api(`/api/port-forwards/${r.data.port_forward.id}`, 'PUT', { includeInSub: true });
    console.log(`  ✅ ${pfName} (CDT:${r.data.port_forward.entry_port} → Hytron:${hPort}) [进订阅]`);
  } else console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 120)}`);
}

// ---- 4) 端到端验证 ----
console.log('\n== 4. 端到端验证(CDT 入口端口) ==');
const final = (await api('/api/port-forwards')).data.filter((f) => f.name.startsWith('Ali-CDT→Hytron→'));
for (const f of final) console.log(`  ${await tcp('cdt.1o1.top', f.entry_port) ? '✅' : '❌'} ${f.name} :${f.entry_port}`);
