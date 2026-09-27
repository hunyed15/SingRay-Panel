// 把 JP-2.99 跳板机切到 Oracle-22 并测试连通性(全程走面板 API)
import crypto from 'node:crypto';

const JWT_SECRET = '38285cdeb4c92ed1b6c2690020713352572324d67bb70c3e829f41d7133418b2';
const H = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const P = Buffer.from(JSON.stringify({ sub: 1, username: 'admin' })).toString('base64url');
const TOKEN = H + '.' + P + '.' + crypto.createHmac('sha256', JWT_SECRET).update(H + '.' + P).digest('base64url');

const api = async (path, method = 'GET', body) => {
  const res = await fetch('http://127.0.0.1:3000' + path, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const servers = (await api('/api/servers')).data;
const jp = servers.find((s) => s.name === 'JP-2.99');
const oracle = servers.find((s) => s.name === 'Oracle-22');
console.log(`JP(id=${jp.id}, jump=${jp.jump_server_id}) → Oracle-22(id=${oracle.id})`);

const upd = await api(`/api/servers/${jp.id}`, 'PUT', {
  name: jp.name, role: jp.role, control: jp.control, host: jp.host, clientHost: jp.client_host,
  sshPort: jp.ssh_port, sshUser: jp.ssh_user, sshAuthType: jp.ssh_auth_type, sshSudo: jp.ssh_sudo === 1,
  jumpServerId: oracle.id,
});
console.log('跳板切换:', upd.status, '→ jump_server_id =', upd.data?.jump_server_id);

console.log('\n== 测试 JP-2.99(经 Oracle-22 隧道,最长 3 分钟) ==');
const test = await api(`/api/servers/${jp.id}/test`, 'POST');
console.log('结果:', JSON.stringify(test.data).slice(0, 200));
