import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const req = createRequire('/opt/singray/apps/server/dist/index.js');
const { Client } = req('ssh2');
const key = crypto.createHash('sha256').update('0723b786c272814e4dce2209c73fd7c027d999de6857854af80d5ff6641937c6', 'utf8').digest();
const dec = (t) => { const [iv, d] = t.split('.'); const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); const b = Buffer.from(d, 'base64'); c.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([c.update(b.subarray(0, b.length - 16)), c.final()]).toString('utf8'); };
const db = new DatabaseSync('/opt/singray/data/panel.db');
const srv = db.prepare("SELECT * FROM servers WHERE name = 'Dedirock'").get();
const conn = new Client();
conn.on('ready', () => {
  conn.exec("xray api statsquery --server=127.0.0.1:18482 -pattern 'inbound>>>' 2>&1 | head -c 400", (e, s) => {
    let o = '';
    s.on('data', (d) => (o += d));
    s.stderr.on('data', (d) => (o += d));
    s.on('close', () => { console.log('DEDIROCK STATS:', o.slice(0, 380)); conn.end(); process.exit(0); });
  });
}).on('error', (e) => { console.log('ERR:', e.message); process.exit(1); }).connect({ host: srv.host, port: srv.ssh_port, username: srv.ssh_user, password: dec(srv.ssh_auth_secret) });
