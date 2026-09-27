// 方案 A: Hytron 建 tunnel 节点(→JP) + Ali-CDT 中转规则
import crypto from 'node:crypto';
import net from 'node:net';

const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');
const api = async (path, method = 'GET', body) => {
  const res = await fetch('http://127.0.0.1:3000' + path, {
    method, headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const tcp = (host, port, ms = 10000) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.removeAllListeners(); s.destroy(); res(r); };
  s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
});

const servers = (await api('/api/servers')).data;
const hytron = servers.find((s) => s.name === 'Hytron');
const cdt = servers.find((s) => s.name === 'Ali-CDT');
const jp = servers.find((s) => s.name === 'JP-2.99');
const jpHost = jp.host; // 2607:8140:212:122:: (纯 IPv6)

const sbNodes = (await api('/api/nodes')).data.filter((n) => n.server_id === jp.id && !['socks', 'http', 'tunnel'].includes(n.protocol));
const xrNodes = (await api('/api/xray/nodes')).data.filter((n) => n.server_id === jp.id && !['socks', 'http', 'tunnel'].includes(n.protocol));
const targets = [...sbNodes, ...xrNodes];
console.log(`目标: ${targets.length} 个 JP 节点`);
console.log('注意: 现有 4 条 Oracle 两跳链路不通,本次先验证 socat IPv6 修复\n');

// ---- 1) Hytron tunnel 节点 ----
console.log('== 1. Hytron tunnel 节点 ==');
const existingT = (await api('/api/nodes')).data.filter((n) => n.server_id === hytron.id && n.protocol === 'tunnel');
const hPorts = {};
for (const t of targets) {
  const short = t.name.replace(/^JP-2\.99-/, '');
  const tname = `JP-via-Hytron-${short}`;
  const ex = existingT.find((e) => e.name === tname);
  if (ex) { hPorts[short] = ex.listen_port; console.log(`  SKIP ${tname} (${ex.listen_port})`); continue; }
  const r = await api('/api/nodes', 'POST', { template: 'tunnel', name: tname, serverId: hytron.id, tunnelAddress: jpHost, tunnelPort: t.listen_port });
  if (r.data?.listen_port) { hPorts[short] = r.data.listen_port; console.log(`  ✅ ${tname} → [${jpHost}]:${t.listen_port} (Hytron:${r.data.listen_port})`); }
  else console.log(`  ❌ ${tname}: ${JSON.stringify(r.data).slice(0, 100)}`);
}

// ---- 2) 部署 Hytron ----
console.log('\n== 2. 部署 Hytron(tunnel 生效) ==');
const dep = await api(`/api/deploy/${hytron.id}`, 'POST');
console.log(`  singbox: ${dep.data?.singbox?.ok ? 'OK' : 'FAIL ' + (dep.data?.singbox?.error || '').slice(0, 120)}`);

// ---- 3) 验证 Hytron → JP ----
console.log('\n== 3. 验证 Hytron tunnel 端口 → JP ==');
for (const [short, p] of Object.entries(hPorts)) {
  console.log(`  ${await tcp('hytron.1o1.top', p) ? '✅' : '❌'} ${short} :${p}`);
}
