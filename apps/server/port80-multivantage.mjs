// 从多个境外视角测试 Hytron 的 80/443/22 端口(排除 GFW 假设)
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const req = createRequire('/opt/singray/apps/server/dist/index.js');
const { Client } = req('ssh2');
const key = crypto.createHash('sha256').update('0723b786c272814e4dce2209c73fd7c027d999de6857854af80d5ff6641937c6', 'utf8').digest();
const dec = (t) => { const [iv, d] = t.split('.'); const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); const b = Buffer.from(d, 'base64'); c.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([c.update(b.subarray(0, b.length - 16)), c.final()]).toString('utf8'); };
const db = new DatabaseSync('/opt/singray/data/panel.db');

const connect = (srv) => new Promise((res, rej) => {
  const conn = new Client();
  const opts = { host: srv.host, port: srv.ssh_port || 22, username: srv.ssh_user, readyTimeout: 20000 };
  if (srv.ssh_auth_type === 'key') opts.privateKey = dec(srv.ssh_auth_secret);
  else opts.password = dec(srv.ssh_auth_secret);
  conn.on('ready', () => res(conn)).on('error', rej).connect(opts);
});
const run = (conn, cmd) => new Promise((res) => conn.exec(cmd, (e, s) => { let o = ''; s.on('data', d => o += d); s.stderr.on('data', d => o += d); s.on('close', () => res(o)); }));

// 目标 Hytron 82.47.33.57
const TEST = 'bash -c \'for p in 80 443 22 8443; do timeout 6 bash -c "cat < /dev/null > /dev/tcp/82.47.33.57/$p" 2>/dev/null && echo "  $p OPEN" || echo "  $p CLOSED"; done\'';

for (const name of ['Dedirock', 'Oracle-22', 'Ali-CDT', 'JP-2.99']) {
  const srv = db.prepare('SELECT * FROM servers WHERE name = ?').get(name);
  if (!srv) { console.log(`${name}: 未找到`); continue; }
  try {
    const conn = await connect(srv);
    const geo = (await run(conn, 'curl -s -m 8 ipinfo.io/country 2>/dev/null || curl -s -m 8 ifconfig.co/country 2>/dev/null || echo "?"')).trim();
    console.log(`\n=== ${name} (${srv.host}, 地区=${geo}) → Hytron:82.47.33.57 ===`);
    console.log((await run(conn, TEST)).trimEnd());
    conn.end();
  } catch (e) { console.log(`\n${name}: 连接失败 ${e.message.slice(0, 60)}`); }
}

// 本机(面板服务器)视角 + 自身地区
console.log('\n=== 面板服务器本地 ===');
console.log(`本机地区: ${(await new Promise((r) => require('node:child_process').exec('curl -s -m 8 ipinfo.io/country 2>/dev/null || echo ?', (e, o) => r(o)))).trim()}`);
