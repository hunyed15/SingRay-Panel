import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const req = createRequire('/opt/singray/apps/server/dist/index.js');
const { Client } = req('ssh2');
const key = crypto.createHash('sha256').update('0723b786c272814e4dce2209c73fd7c027d999de6857854af80d5ff6641937c6', 'utf8').digest();
const dec = (t) => { const [iv, d] = t.split('.'); const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); const b = Buffer.from(d, 'base64'); c.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([c.update(b.subarray(0, b.length - 16)), c.final()]).toString('utf8'); };
const db = new DatabaseSync('/opt/singray/data/panel.db');
const srv = db.prepare("SELECT * FROM servers WHERE name = 'CDT'").get();
const domain = srv.client_host || srv.host;
const conn = new Client();

const run = (cmd) => new Promise((res) => {
  conn.exec(cmd, { pty: false }, (e, s) => {
    let o = '';
    s.on('data', (d) => (o += d));
    s.stderr.on('data', (d) => (o += d));
    s.on('close', (code) => res({ out: o, code }));
  });
});

conn.on('ready', async () => {
  console.log(`[CDT] domain=${domain}`);

  // 0. Ensure curl is available
  console.log('0. Checking curl...');
  const curlCheck = await run('command -v curl 2>&1');
  if (!curlCheck.out.trim()) {
    console.log('  → Installing curl...');
    const ci = await run('apt-get update -qq && apt-get install -y -qq curl 2>&1 | tail -2');
    console.log('  →', ci.out.trim());
  }

  // 1. Install acme.sh (git clone to avoid get.acme.sh redirect issues)
  console.log('1. Installing acme.sh (git clone)...');
  const inst = await run(
    'rm -rf /tmp/acme.sh-src && curl -sL https://github.com/acmesh-official/acme.sh/archive/refs/heads/master.tar.gz -o /tmp/acme.tar.gz && mkdir -p /tmp/acme.sh-src && tar xzf /tmp/acme.tar.gz -C /tmp/acme.sh-src --strip-components=1 && cd /tmp/acme.sh-src && ./acme.sh --install -m admin@' + domain + ' --force 2>&1 | tail -3'
  );
  console.log('  →', inst.out.trim());

  // 2. Set default CA
  await run('~/.acme.sh/acme.sh --set-default-ca --server letsencrypt 2>&1');

  // 3. Issue cert
  console.log('2. Issuing cert for', domain, '...');
  const issue = await run(`~/.acme.sh/acme.sh --issue -d ${domain} --standalone --server letsencrypt 2>&1 | tail -5`);
  console.log('  →', issue.out.trim());

  // 4. Install cert (create directory first)
  console.log('3. Installing cert...');
  await run(`mkdir -p /etc/singray/certs/${domain}`);
  const install = await run(`~/.acme.sh/acme.sh --install-cert -d ${domain} --fullchain-file /etc/singray/certs/${domain}/fullchain.pem --key-file /etc/singray/certs/${domain}/key.pem --reloadcmd "systemctl reload sing-box 2>/dev/null; systemctl restart xray 2>/dev/null; true" 2>&1 | tail -3`);
  console.log('  →', install.out.trim());

  // 5. Verify
  const st = await run(`openssl x509 -noout -subject -enddate -in /etc/singray/certs/${domain}/fullchain.pem 2>&1`);
  console.log('4. Verify:', st.out.trim());

  conn.end();
  process.exit(0);
}).on('error', (e) => { console.log('ERR:', e.message); process.exit(1); }).connect({ host: srv.host, port: srv.ssh_port, username: srv.ssh_user, privateKey: dec(srv.ssh_auth_secret) });
