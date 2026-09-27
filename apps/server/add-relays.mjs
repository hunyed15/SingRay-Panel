// 在生产面板上通过 API 创建 CDT 节点的中转规则并启用进订阅
// 在面板服务器 (146.56.154.19) 上运行
import crypto from 'node:crypto';

const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');

const API = 'http://127.0.0.1:3000';

async function api(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// 1. 获取所有机器和节点
const servers = await api('/api/servers');
const corenet = servers.find(s => s.name === 'CoreNet');
const cdt = servers.find(s => s.name === 'CDT');
if (!corenet || !cdt) { console.error('CoreNet or CDT not found'); process.exit(1); }
console.log(`CoreNet(id=${corenet.id}) → CDT(id=${cdt.id}, host=${cdt.client_host || cdt.host})`);

// 2. 获取 CDT 的所有 xray + sb 节点
const sbNodes = await api('/api/nodes');
const xrNodes = await api('/api/xray/nodes');
const cdtSb = sbNodes.filter(n => n.server_id === cdt.id);
const cdtXr = xrNodes.filter(n => n.server_id === cdt.id);
console.log(`CDT nodes: sb=${cdtSb.length} xray=${cdtXr.length}`);

// 3. 获取现有中转规则
const existing = await api('/api/port-forwards');
const existingKeys = new Set(existing.map(f => `${f.entry_server_id}|${f.target_node_type}|${f.target_node_id}`));

// 4. 为每个 CDT 节点创建 CoreNet→CDT 中转
const results = [];
for (const node of [...cdtXr, ...cdtSb]) {
  const core = cdtXr.includes(node) ? 'xray' : 'singbox';
  const nodeType = cdtXr.includes(node) ? 'xray' : 'singbox';
  const key = `${corenet.id}|${nodeType}|${node.id}`;
  if (existingKeys.has(key)) {
    results.push(`SKIP (已有): CoreNet→${node.name}`);
    continue;
  }
  const r = await api('/api/port-forwards', 'POST', {
    name: `CoreNet→${node.name}`,
    entryServerId: corenet.id,
    landingServerId: cdt.id,
    targetNodeType: nodeType,
    targetNodeId: node.id,
    targetPort: node.listen_port,
    mechanism: 'socat',
    note: '自动创建',
  });
  if (r.port_forward) {
    // 启用进订阅
    await api(`/api/port-forwards/${r.port_forward.id}`, 'PUT', { includeInSub: true });
    results.push(`✅ CoreNet→${node.name} (入口端口 ${r.port_forward.entry_port} → CDT:${node.listen_port}) [已进订阅]`);
  } else {
    results.push(`❌ CoreNet→${node.name}: ${JSON.stringify(r).slice(0, 100)}`);
  }
}

console.log('\n=== 结果 ===');
for (const r of results) console.log(r);
console.log(`\n共 ${results.filter(r => r.startsWith('✅')).length} 新建, ${results.filter(r => r.startsWith('SKIP')).length} 跳过`);
