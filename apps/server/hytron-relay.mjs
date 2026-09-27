// Hytron(socat) → JP-2.99  +  Ali-CDT → Hytron
// 直接建在面板里:入口机=Hytron, 落地机=JP(目标节点), socat 自动用 TCP6 连 IPv6
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
const jp = servers.find((s) => s.name === 'JP-2.99');

// 先清理之前失败的 tunnel 节点
const allSb = (await api('/api/nodes')).data;
console.log('== 清理 Hytron 上失败的 tunnel 节点 ==');
for (const n of allSb.filter((n) => n.server_id === hytron.id && n.protocol === 'tunnel')) {
  await api(`/api/nodes/${n.id}`, 'DELETE');
  console.log(`  删除 ${n.name}`);
}

// JP 目标节点(排除 socks/http/tunnel)
const targets = [
  ...allSb.filter((n) => n.server_id === jp.id && !['socks', 'http', 'tunnel'].includes(n.protocol)).map((n) => ({ type: 'singbox', n })),
  ...(await api('/api/xray/nodes')).data.filter((n) => n.server_id === jp.id && !['socks', 'http', 'tunnel'].includes(n.protocol)).map((n) => ({ type: 'xray', n })),
];
console.log(`\n== Hytron(socat) → JP-2.99 (${targets.length} 个节点) ==`);

const existing = (await api('/api/port-forwards')).data;
const hytronPorts = {};
for (const { type, n } of targets) {
  const short = n.name.replace(/^JP-2\.99-/, '');
  const pfName = `Hytron→${n.name}`;
  const ex = existing.find((f) => f.name === pfName);
  if (ex) { hytronPorts[short] = ex.entry_port; console.log(`  SKIP ${pfName} (${ex.entry_port})`); continue; }
  const r = await api('/api/port-forwards', 'POST', {
    name: pfName, entryServerId: hytron.id, landingServerId: jp.id,
    targetNodeType: type, targetNodeId: n.id, targetPort: n.listen_port, mechanism: 'socat', note: 'CDT→Hytron→JP',
  });
  if (r.data?.port_forward) { hytronPorts[short] = r.data.port_forward.entry_port; console.log(`  ✅ ${pfName} (Hytron:${r.data.port_forward.entry_port} → JP:${n.listen_port})`); }
  else console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 110)}`);
}

console.log('\n== 验证 Hytron 入口端口(应连通到 JP) ==');
for (const [short, p] of Object.entries(hytronPorts)) {
  console.log(`  ${await tcp('hytron.1o1.top', p) ? '✅' : '❌'} ${short} :${p}`);
}
