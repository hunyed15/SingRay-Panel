// Ali-CDT → Oracle-22(sing-box tunnel) → JP-2.99 两跳中转
// 1) 在 Oracle-22 上为 JP 的节点创建 sing-box tunnel 节点(转发到 JP:端口)
// 2) 部署 Oracle-22
// 3) 在 Ali-CDT 上创建中转规则(入口端口 → Oracle-22 tunnel 端口)并进订阅
import crypto from 'node:crypto';

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

const servers = (await api('/api/servers')).data;
const oracle = servers.find((s) => s.name === 'Oracle-22');
const cdt = servers.find((s) => s.name === 'Ali-CDT');
const jp = servers.find((s) => s.name === 'JP-2.99');

// JP 要中转的节点(排除 socks/http —— 它们不进订阅)
const sbNodes = (await api('/api/nodes')).data.filter((n) => n.server_id === jp.id && n.protocol !== 'socks' && n.protocol !== 'http');
const xrNodes = (await api('/api/xray/nodes')).data.filter((n) => n.server_id === jp.id && n.protocol !== 'socks' && n.protocol !== 'http');
const targets = [...sbNodes, ...xrNodes];
console.log(`编排: Ali-CDT → Oracle-22 → JP-2.99,共 ${targets.length} 个 JP 节点`);

// ---- 1) 在 Oracle-22 建 tunnel 节点 ----
const existingTunnels = (await api('/api/nodes')).data.filter((n) => n.server_id === oracle.id && n.protocol === 'tunnel');
console.log(`\n== 1. Oracle-22 tunnel 节点(已有 ${existingTunnels.length}) ==`);
const tunnelPorts = {};
for (const t of targets) {
  const tname = `JP-via-Oracle-${t.name.replace(/^JP-2\.99-/, '')}`;
  if (existingTunnels.some((e) => e.name === tname)) {
    const e = existingTunnels.find((x) => x.name === tname);
    tunnelPorts[t.name] = e.listen_port;
    console.log(`  SKIP ${tname} (已有, 端口 ${e.listen_port})`);
    continue;
  }
  const r = await api('/api/nodes', 'POST', {
    template: 'tunnel',
    name: tname,
    serverId: oracle.id,
    tunnelAddress: jp.host,
    tunnelPort: t.listen_port,
  });
  if (r.data?.listen_port) {
    tunnelPorts[t.name] = r.data.listen_port;
    console.log(`  ✅ ${tname} → ${jp.host}:${t.listen_port} (Oracle 端口 ${r.data.listen_port})`);
  } else {
    console.log(`  ❌ ${tname}: ${JSON.stringify(r.data).slice(0, 120)}`);
  }
}

// ---- 2) 部署 Oracle-22 ----
console.log('\n== 2. 部署 Oracle-22 ==');
const dep = await api(`/api/deploy/${oracle.id}`, 'POST');
console.log(`  singbox: ${dep.data?.singbox?.ok ? 'OK' : 'FAIL ' + (dep.data?.singbox?.error || '').slice(0, 100)}`);
console.log(`  xray: ${dep.data?.xray?.ok ? 'OK' : 'FAIL ' + (dep.data?.xray?.error || '').slice(0, 100)}`);

// ---- 3) Ali-CDT 中转规则 ----
console.log('\n== 3. Ali-CDT 中转规则 ==');
const existingPf = (await api('/api/port-forwards')).data;
for (const t of targets) {
  const tname = `JP-via-Oracle-${t.name.replace(/^JP-2\.99-/, '')}`;
  const oraclePort = tunnelPorts[t.name];
  if (!oraclePort) { console.log(`  SKIP ${t.name}(无 tunnel 端口)`); continue; }
  const pfName = `Ali-CDT→${tname}`;
  if (existingPf.some((f) => f.name === pfName)) { console.log(`  SKIP ${pfName}(已有)`); continue; }
  const r = await api('/api/port-forwards', 'POST', {
    name: pfName,
    entryServerId: cdt.id,
    landingServerId: oracle.id,
    targetNodeType: 'singbox',
    targetNodeId: (await api('/api/nodes')).data.find((n) => n.name === tname)?.id,
    targetPort: oraclePort,
    mechanism: 'socat',
    note: '两跳中转:CDT→Oracle→JP',
  });
  if (r.data?.port_forward) {
    await api(`/api/port-forwards/${r.data.port_forward.id}`, 'PUT', { includeInSub: true });
    console.log(`  ✅ ${pfName} (入口 ${r.data.port_forward.entry_port} → Oracle:${oraclePort}) [进订阅]`);
  } else {
    console.log(`  ❌ ${pfName}: ${JSON.stringify(r.data).slice(0, 120)}`);
  }
}
console.log('\n完成');
