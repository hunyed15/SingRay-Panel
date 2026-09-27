// 查询服务器与会话状态(只读)
import crypto from 'node:crypto';
const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');
const api = async (p) => (await fetch('http://127.0.0.1:3000' + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();

const servers = await api('/api/servers');
console.log('=== 服务器 ===');
for (const s of servers) console.log(` id=${s.id} ${s.name} role=${s.role} host=${s.host} client=${s.client_host || '-'}`);

const sb = await api('/api/nodes');
const xr = await api('/api/xray/nodes');
console.log('\n=== JP-2.99 (id=6) 节点 ===');
const jp = servers.find((s) => s.name === 'JP-2.99');
for (const n of [...sb.filter((n) => n.server_id === jp.id), ...xr.filter((n) => n.server_id === jp.id)]) {
  console.log(` [${n.protocol}] ${n.name} :${n.listen_port} enabled=${n.enabled}`);
}
console.log('\n=== Oracle-22 (id=4) 节点 ===');
const or = servers.find((s) => s.name === 'Oracle-22');
for (const n of [...sb.filter((n) => n.server_id === or.id), ...xr.filter((n) => n.server_id === or.id)]) {
  console.log(` [${n.protocol}] ${n.name} :${n.listen_port}`);
}
console.log('\n=== 现有中转规则 ===');
for (const f of await api('/api/port-forwards')) {
  console.log(` ${f.entry_server_name}→${f.target_node_name} ${f.entry_port}→${f.target_port} sub=${f.include_in_sub}`);
}