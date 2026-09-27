// 清理 Oracle 两跳中间跳(保留 Hytron 方案),并补 Hytron 证书
import crypto from 'node:crypto';
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

// 1. 删除 Oracle 中间跳的中转规则(名称含 JP-via-Oracle)
console.log('== 1. 删除 Oracle 中间跳规则 ==');
for (const f of (await api('/api/port-forwards')).data.filter((f) => f.name.includes('JP-via-Oracle'))) {
  const r = await api(`/api/port-forwards/${f.id}`, 'DELETE');
  console.log(`  ${r.status === 200 ? '✅' : '❌'} 删除 ${f.name}`);
}
// 2. 删除 Oracle 上的 tunnel 节点
console.log('\n== 2. 删除 Oracle tunnel 节点 ==');
for (const n of (await api('/api/nodes')).data.filter((n) => n.protocol === 'tunnel')) {
  const r = await api(`/api/nodes/${n.id}`, 'DELETE');
  console.log(`  ${r.status === 200 ? '✅' : '❌'} 删除 ${n.name}`);
}
// 3. Hytron 证书状态
console.log('\n== 3. Hytron 证书状态 ==');
const servers = (await api('/api/servers')).data;
const hytron = servers.find((s) => s.name === 'Hytron');
const cs = await api(`/api/servers/${hytron.id}/cert-status`);
console.log('  ', JSON.stringify(cs.data).slice(0, 200));
console.log('\n完成');
