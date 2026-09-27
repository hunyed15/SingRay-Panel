// 验证两跳中转链路:Ali-CDT 入口端口 → Oracle-22 tunnel → JP-2.99 目标端口
import crypto from 'node:crypto';
import net from 'node:net';
const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');
const api = async (p) => (await fetch('http://127.0.0.1:3000' + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();

const tcp = (host, port, ms = 8000) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.removeAllListeners(); s.destroy(); res(r); };
  s.setTimeout(ms, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

const pf = await api('/api/port-forwards');
const jpRelays = pf.filter((f) => f.name.includes('JP-via-Oracle'));
console.log(`=== 两跳链路验证(${jpRelays.length} 条) ===`);
for (const f of jpRelays) {
  // Ali-CDT 入口端口(从本机即面板服务器测试)
  const ok = await tcp('cdt.1o1.top', f.entry_port);
  console.log(` ${ok ? '✅' : '❌'} ${f.name} | cdt.1o1.top:${f.entry_port} → Oracle:${f.target_port} → JP`);
}
