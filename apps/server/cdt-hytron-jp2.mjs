// 正确模型的两跳中转:
// CDT 规则:落地机=Hytron, 目标节点=JP节点(提供订阅参数), targetPort=Hytron入口端口
// 结果:订阅链接 = cdt.1o1.top:CDT端口 + JP节点参数
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

const sbAll = (await api('/api/nodes')).data;
const xrAll = (await api('/api/xray/nodes')).data;

// Hytron→JP 规则(已存在) → 得到 Hytron 入口端口
const pfs = (await api('/api/port-forwards')).data;
const hyJp = pfs.filter((f) => f.name.startsWith('Hytron→JP-2.99-'));

console.log('== 用 JP 节点重建 CDT 侧规则(落地机=Hytron) ==');
for (const f of hyJp) {
  const short = f.name.replace(/^Hytron→JP-2\.99-/, '');
  const jpNode = [...sbAll, ...xrAll].find((n) => n.name === `JP-2.99-${short}`);
  if (!jpNode) { console.log(`  ❌ 找不到 JP 节点 ${short}`); continue; }
  const nodeType = xrAll.some((n) => n.id === jpNode.id) ? 'xray' : 'singbox';
  const pfName = `Ali-CDT→Hytron→${short}`;

  const ex = pfs.find((x) => x.name === pfName);
  if (ex) { console.log(`  SKIP ${pfName}(已有, 端口 ${ex.entry_port})`); continue; }

  const r = await api('/api/port-forwards', 'POST', {
    name: pfName,
    entryServerId: cdt.id,
    landingServerId: hytron.id,      // 实际转发目标 = Hytron
    targetNodeType: nodeType,        // JP 节点(提供订阅参数)
    targetNodeId: jpNode.id,
    targetPort: f.entry_port,        // Hytron 的 socat 入口端口
    mechanism: 'socat',
    includeInSub: true,
    note: '两跳:CDT→Hytron→JP',
  });
  if (r.data?.port_forward) console.log(`  ✅ ${pfName} (CDT:${r.data.port_forward.entry_port} → Hytron:${f.entry_port}) [进订阅]`);
  else console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 130)}`);
}

// 端到端验证
console.log('\n== 端到端验证 ==');
const all = (await api('/api/port-forwards')).data.filter((f) => f.name.startsWith('Ali-CDT→Hytron→'));
for (const f of all) {
  console.log(`  ${await tcp('8.210.172.76', f.entry_port) ? '✅' : '❌'} ${f.name} | CDT:${f.entry_port} → Hytron:${f.target_port} → JP`);
}
