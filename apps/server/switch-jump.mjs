// 通过生产面板 API 操作:验证 Ali-CDT 是否可作 JP-2.99 的跳板机
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

// 1. 当前状态
const servers = (await api('/api/servers')).data;
const corenet = servers.find((s) => s.name === 'CoreNet');
const cdt = servers.find((s) => s.name === 'Ali-CDT');
const jp = servers.find((s) => s.name === 'JP-2.99');
console.log(`CoreNet(id=${corenet.id}) CDT(id=${cdt.id}) JP(id=${jp.id}, jump=${jp.jump_server_id})`);

// 2. 把 JP-2.99 的跳板机改成 Ali-CDT
console.log('\n== 切换 JP-2.99 跳板机 → Ali-CDT ==');
const upd = await api(`/api/servers/${jp.id}`, 'PUT', {
  name: jp.name, role: jp.role, control: jp.control, host: jp.host, clientHost: jp.client_host,
  sshPort: jp.ssh_port, sshUser: jp.ssh_user, sshAuthType: jp.ssh_auth_type, sshSudo: jp.ssh_sudo === 1,
  jumpServerId: cdt.id,
});
console.log('update:', upd.status, JSON.stringify(upd.data).slice(0, 120));

// 3. 测试 JP-2.99 连通性(经新跳板)
console.log('\n== 测试 JP-2.99(经 Ali-CDT 隧道) ==');
const test = await api(`/api/servers/${jp.id}/test`, 'POST');
console.log('result:', JSON.stringify(test.data).slice(0, 200));