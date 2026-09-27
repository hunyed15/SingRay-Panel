// 分段诊断两跳链路
import crypto from 'node:crypto';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
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

console.log('=== 分段诊断 ===');
// A. 本机 → Oracle-22 tunnel 端口(直连)
console.log('A. 面板 → Oracle tunnel 端口:');
for (const [name, port] of [['vless-sb', 27636], ['vmess-sb', 60168], ['vless-xray', 26099], ['vmess-xray', 41378]]) {
  console.log(`   ${await tcp('oracle122.1o1.top', port) ? '✅' : '❌'} ${name} :${port}`);
}
// B. 本机 → Oracle-22 的 xray 原生端口(对照:确认 Oracle 可达)
console.log('B. 面板 → Oracle 原生节点端口(对照):');
console.log(`   ${await tcp('oracle122.1o1.top', 28821) ? '✅' : '❌'} vless-reality-xray :28821`);

// C. 查 CDT 上的 socat 单元
const db = new DatabaseSync('/opt/singray/data/panel.db', { readOnly: true });
const cdt = db.prepare("SELECT * FROM servers WHERE name = 'Ali-CDT'").get();
const { Client } = (await import('node:module')).createRequire('/opt/singray/apps/server/dist/index.js')('ssh2');
const key = crypto.createHash('sha256').update('0723b786c272814e4dce2209c73fd7c027d999de6857854af80d5ff6641937c6', 'utf8').digest();
const dec = (t) => { const [iv, d] = t.split('.'); const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); const b = Buffer.from(d, 'base64'); c.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([c.update(b.subarray(0, b.length - 16)), c.final()]).toString('utf8'); };
const conn = new Client();
const run = (conn, cmd) => new Promise((res) => conn.exec(cmd, (e, s) => { let o = ''; s.on('data', (d) => (o += d)); s.stderr.on('data', (d) => (o += d)); s.on('close', () => res(o)); }));
await new Promise((res) => conn.on('ready', res).on('error', () => res()).connect({ host: cdt.host, port: 22, username: cdt.ssh_user, password: dec(cdt.ssh_auth_secret) }));
console.log('C. Ali-CDT socat 单元:');
console.log('  ', (await run(conn, "systemctl list-units 'singray-fwd-*' --no-legend --all 2>/dev/null | awk '{print $1, $3, $4}' | tr '\\n' '|'")).slice(0, 500));
console.log('   监听端口:', (await run(conn, "ss -tln | grep -oE ':(34309|20209|27925|58071)' | tr '\\n' ' '")).trim() || '(无)');
console.log('   某单元日志:', (await run(conn, 'journalctl -u singray-fwd-34309 --no-pager -n 3 2>&1 | tail -3')).slice(0, 300));
conn.end();
process.exit(0);
