// 通过面板 API 重部署机器 1/4/6 + 触发采集 + 读取 Dashboard 摘要
// 在面板服务器上运行(有 ssh2 模块和 panel.env)

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/etc/singray/panel.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.split('=')[0], l.split('=').slice(1).join('=')])
);
const TOKEN = (() => {
  const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
  return H + '.' + P + '.' + crypto.createHmac('sha256', env.PANEL_JWT_SECRET).update(H + '.' + P).digest('base64url');
})();

async function api(path, method = 'GET', body) {
  const res = await fetch('http://127.0.0.1:3000' + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

for (const id of [1, 4, 6]) {
  const r = await api(`/api/deploy/${id}`, 'POST');
  console.log(`deploy #${id}: sb ${r.singbox?.ok ? 'OK' : 'FAIL: ' + (r.singbox?.error || '').slice(0, 50)} | xray ${r.xray?.ok ? 'OK' : 'FAIL: ' + (r.xray?.error || '').slice(0, 50)}`);
}

const col = await api('/api/traffic/collect', 'POST');
console.log('collect:', col.summary);

const dash = await api('/api/traffic/dashboard');
console.log(`dashboard: machines ${dash.machines.online}/${dash.machines.total} | pending ${dash.pendingDeploys.length} | traffic nodes ${dash.traffic.top.length} | up ${dash.traffic.totalUp} down ${dash.traffic.totalDown}`);
