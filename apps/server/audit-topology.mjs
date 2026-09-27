// 核对当前生产拓扑:机器 / IP栈 / 跳板 / 中转链路
import crypto from 'node:crypto';
const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');
const api = async (p) => (await fetch('http://127.0.0.1:3000' + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();

const servers = await api('/api/servers');
const nameOf = Object.fromEntries(servers.map((s) => [s.id, s.name]));

console.log('=== 1. 机器清单与 IP 栈 ===');
for (const s of servers) {
  const isV6 = s.host.includes(':');
  console.log(` ${s.name.padEnd(12)} role=${s.role.padEnd(8)} host=${s.host.padEnd(32)} 跳板=${s.jump_server_id ? nameOf[s.jump_server_id] : '直连'}`);
}

console.log('\n=== 2. 中转规则(全部) ===');
const pf = await api('/api/port-forwards');
const byName = {};
for (const f of pf) {
  (byName[f.entry_server_name] ||= []).push(f);
}
for (const [entry, list] of Object.entries(byName)) {
  console.log(` [入口 ${entry}] ${list.length} 条`);
  for (const f of list) {
    console.log(`   ${f.name}`);
    console.log(`      入口 :${f.entry_port} → 落地机 ${f.landing_server_name} :${f.target_port} | 机制 ${f.mechanism} | 进订阅 ${f.include_in_sub === 1 ? '✓' : '✗'}`);
  }
}

console.log('\n=== 3. 各机器节点(hytron/cdt 上的中转性质节点) ===');
const sb = await api('/api/nodes');
const xr = await api('/api/xray/nodes');
for (const s of servers) {
  const sbn = sb.filter((n) => n.server_id === s.id);
  const xrn = xr.filter((n) => n.server_id === s.id);
  if (sbn.length + xrn.length === 0) { console.log(` ${s.name}: (无节点)`); continue; }
  console.log(` ${s.name}: sb=${sbn.length} xray=${xrn.length}`);
}
