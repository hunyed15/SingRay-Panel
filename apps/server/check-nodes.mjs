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
  const opts = { host: srv.host, port: srv.ssh_port || 22, username: srv.ssh_user };
  if (srv.ssh_auth_type === 'key') opts.privateKey = dec(srv.ssh_auth_secret);
  else opts.password = dec(srv.ssh_auth_secret);
  conn.on('ready', () => res(conn)).on('error', rej).connect(opts);
});
const run = (conn, cmd) => new Promise((res) => {
  conn.exec(cmd, (e, s) => { let o = ''; s.on('data', d => o += d); s.stderr.on('data', d => o += d); s.on('close', () => res(o)); });
});

const oracle = db.prepare("SELECT * FROM servers WHERE name = 'Oracle-22'").get();
const cdt = db.prepare("SELECT * FROM servers WHERE name = 'CDT'").get();

// 1. Oracle-22: xray status + vmess port listening + cert check
console.log('=== Oracle-22 ===');
const oConn = await connect(oracle);
console.log('xray:', await run(oConn, 'systemctl is-active xray'));
console.log('vmess port 23598:', await run(oConn, 'ss -tln | grep 23598 || echo NOT-LISTENING'));
console.log('cert:', await run(oConn, "openssl x509 -noout -issuer -subject -in /etc/singray/certs/oracle122.1o1.top/fullchain.pem 2>&1 | head -2"));
console.log('xray config vmess section:', await run(oConn, "grep -A5 '23598' /etc/xray/config.json | head -6"));
oConn.end();

// 2. CDT: socat relay + xhttp node config
console.log('=== CDT ===');
const cConn = await connect(cdt);
console.log('socat:', await run(cdtConn => cdtConn, '') /* placeholder */);
console.log('socat units:', await run(cConn, "systemctl list-units 'singray-fwd-*' --no-legend | awk '{print $1}' | tr '\\n' ' ' || echo none"));
console.log('xray:', await run(cConn, 'systemctl is-active xray'));
console.log('xhttp node:', await run(cConn, "grep -A3 'xhttp' /etc/xray/config.json | head -5 || echo no-xhttp"));
cConn.end();
process.exit(0);
