// api 客户端的错误契约:状态码 + 中文消息 + 401 会话过期行为
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { message } from 'antd';

vi.mock('antd', () => ({ message: { error: vi.fn(), success: vi.fn() } }));

import * as api from './api';
import { ApiError } from './api';
import { getToken, setToken } from './auth';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('api 客户端', () => {
  beforeEach(() => {
    vi.mocked(message.error).mockClear();
    window.history.pushState({}, '', '/login'); // 避免 401 分支触发真实跳转
  });

  it('200 → 返回解析后的 body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [{ id: 1, name: 'HK1' }])));
    const servers = await api.getServers();
    expect(servers).toEqual([{ id: 1, name: 'HK1' }]);
    expect(message.error).not.toHaveBeenCalled();
  });

  it('409 → 抛 ApiError(带状态码/后端 code/中文消息)并弹一次全局提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: '端口 30001 已被占用', code: 'conflict' })));
    const err = await api.getServers().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
    expect((err as InstanceType<typeof ApiError>).code).toBe('conflict');
    expect((err as Error).message).toBe('端口 30001 已被占用');
    expect(message.error).toHaveBeenCalledTimes(1);
    expect(message.error).toHaveBeenCalledWith('端口 30001 已被占用');
  });

  it('401 unauthorized → 清 token 并提示登录过期', async () => {
    setToken('stale-token');
    expect(getToken()).toBe('stale-token');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized', code: 'unauthorized' })));

    const err = await api.getServers().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('登录已过期,请重新登录');
    expect((err as InstanceType<typeof ApiError>).code).toBe('unauthorized');
    expect(getToken()).toBeNull();
  });

  it('401 invalid_credentials(登录密码错)→ 不清 token,按普通错误处理', async () => {
    setToken('keep-me');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: '用户名或密码错误', code: 'invalid_credentials' })),
    );
    const err = await api.getServers().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('用户名或密码错误');
    expect((err as InstanceType<typeof ApiError>).code).toBe('invalid_credentials');
    expect(getToken()).toBe('keep-me');
  });

  it('401 invalid_credentials(登录密码错)→ 不清 token,按普通错误提示', async () => {
    setToken('keep-me');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: '用户名或密码错误', code: 'invalid_credentials' })),
    );
    const err = await api.getServers().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('用户名或密码错误');
    expect((err as InstanceType<typeof ApiError>).code).toBe('invalid_credentials');
    expect(getToken()).toBe('keep-me');
  });

  it('网络失败 → status 0 的 ApiError(不把 fetch 异常原样抛给页面)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api.getServers()).rejects.toMatchObject({
      status: 0,
      message: '无法连接面板后端,请检查服务是否启动',
    });
  });

  it('带 token 时加 Authorization 头,无 body 时不带 Content-Type', async () => {
    setToken('abc');
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await api.getServers();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});
