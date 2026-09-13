// 路由集成测试:fastify.inject 走完整 HTTP 栈(bootstrap → login → Bearer CRUD)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// config 在模块加载期读环境变量,必须先于 import 生效
vi.hoisted(() => {
  process.env.PANEL_DB = ':memory:';
  process.env.PANEL_JWT_SECRET = 'test-jwt-secret';
  delete process.env.PANEL_ADMIN_PASSWORD; // 用默认 admin/admin888
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
      payload: { template: 'trojan-tls', name: 'n1', serverId: srv.id, port: 30001 },
    });
    expect(created.statusCode).toBe(200);
    const node = created.json();
    expect(node.protocol).toBe('trojan');
    expect(node.listen_port).toBe(30001);
    expect(node.share_link).toMatch(/^trojan:\/\//);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth,
      payload: { template: 'trojan-tls', name: 'n2', serverId: srv.id, port: 30001 },
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
    });
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
