// Ali-CDT → Hytron(已就绪)  + 端到端验证(用 IP 测试,绕开 hytron 域名缺失)
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

// 1. 已有 Hytron→JP 规则
const pfs = (await api('/api/port-forwards')).data;
const hytronJp = pfs.filter((f) => f.name.startsWith('Hytron→JP-2.99-'));
console.log(`== 现有 Hytron→JP 规则: ${hytronJp.length} 条 ==`);
for (const f of hytronJp) console.log(`  ${f.name}: Hytron:${f.entry_port} → JP:${f.target_port}`);

// 2. Ali-CDT → Hytron (用 IP 作为目标端口转发)
console.log('\n== Ali-CDT → Hytron ==');
const results = [];
for (const f of hytronJp) {
  const short = f.name.replace(/^Hytron→JP-2\.99-/, '');
  const pfName = `Ali-CDT→Hytron→${short}`;
  if (pfs.some((x) => x.name === pfName)) { console.log(`  SKIP ${pfName}(已有)`); continue; }
  // 入口机=CDT, 落地机=Hytron, 目标端口=Hytron 的入口端口
  const r = await api('/api/port-forwards', 'POST', {
    name: pfName, entryServerId: cdt.id, landingServerId: hytron.id,
    targetNodeType: 'singbox', targetNodeId: 1, // 占位(不用于转发逻辑)
    targetPort: f.entry_port, mechanism: 'socat', note: '两跳:CDT→Hytron→JP',
  });
  if (r.data?.port_forward) {
    await api(`/api/port-forwards/${r.data.port_forward.id}`, 'PUT', { includeInSub: true });
    results.push({ name: pfName, port: r.data.port_forward.entry_port });
    console.log(`  ✅ ${pfName} (CDT:${r.data.port_forward.entry_port} → Hytron:${f.entry_port}) [进订阅]`);
  } else console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 130)}`);
}

// 3. 端到端验证(CDT 用 IP:8.210.172.76)
console.log('\n== 端到端验证(CDT 入口端口 → Hytron → JP) ==');
for (const r of results) {
  console.log(`  ${await tcp('8.210.172.76', r.port) ? '✅' : '❌'} ${r.name} :${r.port}`);
}
