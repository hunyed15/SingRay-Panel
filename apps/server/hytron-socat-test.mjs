// Hytron 上直接测试 socat IPv6 转发能力
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const req = createRequire('/opt/singray/apps/server/dist/index.js');
const { Client } = req('ssh2');
const key = crypto.createHash('sha256').update('0723b786c272814e4dce2209c73fd7c027d999de6857854af80d5ff6641937c6', 'utf8').digest();
const dec = (t) => { const [iv, d] = t.split('.'); const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); const b = Buffer.from(d, 'base64'); c.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([c.update(b.subarray(0, b.length - 16)), c.final()]).toString('utf8'); };
const db = new DatabaseSync('/opt/singray/data/panel.db');
const srv = db.prepare("SELECT * FROM servers WHERE name = 'Hytron'").get();
const conn = new Client();
const run = (cmd) => new Promise((res) => conn.exec(cmd, (e, s) => { let o = ''; s.on('data', d => o += d); s.stderr.on('data', d => o += d); s.on('close', () => res(o)); }));

conn.on('ready', async () => {
  console.log('=== Hytron 环境检查 ===');
  console.log('socat:', (await run('command -v socat || echo MISSING')).trim());
  console.log('IPv6 地址:', (await run("ip -6 addr show scope global 2>/dev/null | grep -oE 'inet6 [0-9a-f:]+' | head -2")).trim() || '(无全局 v6)');
  console.log('IPv6 路由测试:', (await run('ping6 -c 1 -W 3 2607:8140:212:122:: 2>&1 | tail -1')).trim());
  console.log('直连 JP 端口 28851:', (await run('timeout 6 bash -c "cat < /dev/null > /dev/tcp/2607:8140:212:122::/28851" 2>&1 && echo OPEN || echo FAIL')).trim());

  // 手工 socat 测试(临时,前台 5 秒)
  console.log('\n=== 手工 socat IPv6 转发测试 ===');
  await run('pkill -f "socat TCP-LISTEN:39999" 2>/dev/null; nohup socat TCP-LISTEN:39999,fork,reuseaddr TCP6:[2607:8140:212:122::]:28851 >/dev/null 2>&1 &');
  await new Promise(r => setTimeout(r, 2000));
  console.log('socat 进程:', (await run('pgrep -af "socat TCP-LISTEN:39999" | head -1')).trim() || '(未启动)');
  console.log('socat 报错:', (await run('pkill -f "socat TCP-LISTEN:39999"; echo killed')).trim());

  // 用 socat 加详细日志再测
  await run('pkill -f "socat TCP-LISTEN:39998"; socat -d -d TCP-LISTEN:39998,fork,reuseaddr TCP6:[2607:8140:212:122::]:28851 > /tmp/socat-test.log 2>&1 &');
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n从本机测 39998:');
  await run('timeout 5 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/39998" 2>&1 && echo LOCAL-OK || echo LOCAL-FAIL');
  await new Promise(r => setTimeout(r, 1000));
  console.log('socat 日志:', (await run('tail -5 /tmp/socat-test.log')).trim());
  await run('pkill -f "socat TCP-LISTEN:39998"; rm -f /tmp/socat-test.log');
  conn.end(); process.exit(0);
}).on('error', (e) => { console.log('ERR:', e.message); process.exit(1); }).connect({ host: srv.host, port: srv.ssh_port, username: srv.ssh_user, privateKey: dec(srv.ssh_auth_secret) });
