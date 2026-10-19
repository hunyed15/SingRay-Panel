// 路由集成测试:fastify.inject 走完整 HTTP 栈(bootstrap → login → Bearer CRUD)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// config 在模块加载期读环境变量,必须先于 import 生效
vi.hoisted(() => {
  process.env.PANEL_DB = ':memory:';
  process.env.PANEL_JWT_SECRET = 'test-jwt-secret';
  // 管理员口令必须显式配置:面板不再使用固定默认口令 admin888(未配置时随机生成并打印)
  process.env.PANEL_ADMIN_PASSWORD = 'admin888';
});

const { buildApp } = await import('../index.js');
const { closeDb } = await import('../db/client.js');

describe('api integration (fastify.inject)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    closeDb();
  });

  let token = '';

  it('bootstraps admin and logs in', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: '用户名或密码错误' });

    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin888' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe('admin');
    expect(typeof body.token).toBe('string');
    token = body.token;
  });

  it('rejects unauthenticated /api requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('servers CRUD + role settings happy path', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: auth,
      payload: { name: 'hk-landing', role: 'landing', host: '10.0.0.1', sshAuthSecret: 'KEY', sshPort: 22 },
    });
    expect(created.statusCode).toBe(200);
    const server = created.json();
    expect(server.name).toBe('hk-landing');
    expect(server).not.toHaveProperty('ssh_auth_secret'); // 凭据不回显

    const list = await app.inject({ method: 'GET', url: '/api/servers', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    return server as { id: number };
  });

  it('nodes CRUD via api with port conflict 409', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const srv = (await app.inject({ method: 'POST', url: '/api/servers', headers: auth, payload: { name: 's1', role: 'landing', host: '10.0.0.2', sshAuthSecret: 'K' } })).json();

    const created = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth,
      payload: { template: 'vmess-ws-tls', name: 'n1', serverId: srv.id, port: 30001 },
    });
    expect(created.statusCode).toBe(200);
    const node = created.json();
    expect(node.protocol).toBe('vmess');
    expect(node.listen_port).toBe(30001);
    expect(node.share_link).toMatch(/^vmess:\/\//);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth,
      payload: { template: 'vmess-ws-tls', name: 'n2', serverId: srv.id, port: 30001 },
    });
    expect(dup.statusCode).toBe(409);

    const toggled = await app.inject({ method: 'POST', url: `/api/nodes/${node.id}/toggle`, headers: auth });
    expect(toggled.json().enabled).toBe(0);

    const del = await app.inject({ method: 'DELETE', url: `/api/nodes/${node.id}`, headers: auth });
    expect(del.json()).toEqual({ ok: true });
  });

  it('xray node create + purge via api', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const srv = (await app.inject({ method: 'GET', url: '/api/servers', headers: auth })).json()[0];
    const created = await app.inject({
      method: 'POST',
      url: '/api/xray/nodes',
      headers: auth,
      payload: { template: 'xray-vless-reality', name: 'x1', serverId: srv.id, port: 31001 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ protocol: 'vless', tls_mode: 'reality', flow: 'xtls-rprx-vision' });

    const purged = await app.inject({ method: 'POST', url: '/api/xray/nodes/purge', headers: auth, payload: {} });
    expect(purged.statusCode).toBe(200);
    expect(purged.json().deleted).toBe(1);
  });

  it('snis and settings via api', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const add = await app.inject({ method: 'POST', url: '/api/snis', headers: auth, payload: { domain: 'www.example.com', note: '测试' } });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ domain: 'www.example.com', builtin: 0 });

    const dup = await app.inject({ method: 'POST', url: '/api/snis', headers: auth, payload: { domain: 'www.example.com' } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/snis', headers: auth, payload: { domain: 'not a domain' } });
    expect(bad.statusCode).toBe(400);

    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: auth });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().subSlug).toMatch(/^[0-9a-f]{12}$/);

    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { subSlug: 'my-slug_1' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      subSlug: 'my-slug_1',
      subUrl: '/sub/singbox/my-slug_1',
      singboxRealityIp: true,
      xrayRealityIp: true,
      cfTokenSet: false,
      cfTokenSource: 'none',
      tgBotTokenSet: false,
      tgChatId: '',
    });
  });

  it('port whitelist (NAT) gates node/forward ports + batch preview', async () => {
    const auth = { authorization: `Bearer ${token}` };

    // 非法格式在保存时就 400,而不是等到分配端口时才发现
    const bad = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: auth,
      payload: { name: 'bad-nat', role: 'landing', host: '10.9.0.9', sshAuthSecret: 'K', portAllow: 'abc' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('无法识别');

    const nat = (
      await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: auth,
        payload: { name: 'nat-relay', role: 'relay', host: '10.9.0.1', sshAuthSecret: 'K', portAllow: '32679-32681' },
      })
    ).json();
    expect(nat.port_allow).toBe('32679-32681');

    const land = (
      await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: auth,
        payload: { name: 'nat-land', role: 'landing', host: '10.9.0.3', sshAuthSecret: 'K', portAllow: '32679-32699' },
      })
    ).json();

    // 手填白名单外的端口 → 400
    const outOfRange = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth,
      payload: { template: 'vmess-ws-tls', name: 'oor', serverId: land.id, port: 40000 },
    });
    expect(outOfRange.statusCode).toBe(400);
    expect(outOfRange.json().error).toContain('可用端口白名单');

    // 留空 → 在白名单内分配(取最小可用)
    const auto = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth,
      payload: { template: 'vmess-ws-tls', name: 'auto-port', serverId: land.id },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().listen_port).toBe(32679);

    // 一键添加预览:入口机白名单内分配,且避开全局已用端口(32679 已被上面节点占用)
    const preview = await app.inject({
      method: 'POST',
      url: '/api/port-forwards/batch/preview',
      headers: auth,
      payload: { entryServerIds: [nat.id], targets: [{ type: 'singbox', id: auto.json().id }] },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ createCount: 1, skipCount: 0 });
    expect(preview.json().items[0]).toMatchObject({ entryPort: 32680, core: 'singbox', action: 'create' });

    const emptySelection = await app.inject({
      method: 'POST',
      url: '/api/port-forwards/batch/preview',
      headers: auth,
      payload: { entryServerIds: [], targets: [] },
    });
    expect(emptySelection.statusCode).toBe(400);
  });

  it('account password change via api', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const wrongOld = await app.inject({ method: 'PUT', url: '/api/auth/account', headers: auth, payload: { oldPassword: 'nope', newPassword: 'newpass123' } });
    expect(wrongOld.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PUT', url: '/api/auth/account', headers: auth, payload: { oldPassword: 'admin888', newPassword: 'newpass123' } });
    expect(ok.statusCode).toBe(200);

    const relogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'newpass123' } });
    expect(relogin.statusCode).toBe(200);
  });
});
