// 检查 Hytron 上 socat 单元实际状态
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
  console.log('=== socat 单元状态 ===');
  console.log(await run("systemctl list-units 'singray-fwd-*' --all --no-legend 2>/dev/null"));
  console.log('=== 单元文件内容(55177) ===');
  console.log(await run('cat /etc/systemd/system/singray-fwd-55177.service 2>&1'));
  console.log('=== 单元状态详情 ===');
  console.log(await run('systemctl status singray-fwd-55177 --no-pager -n 8 2>&1 | tail -10'));
  console.log('=== 监听端口 ===');
  console.log(await run("ss -tln | grep -E '55177|42764|20107|25229' || echo NONE-LISTENING"));
  conn.end(); process.exit(0);
}).on('error', (e) => { console.log('ERR:', e.message); process.exit(1); }).connect({ host: srv.host, port: srv.ssh_port, username: srv.ssh_user, password: dec(srv.ssh_auth_secret) });
