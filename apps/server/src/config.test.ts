import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 弱密钥守卫:必须与监听地址无关。
 * 旧实现的守卫条件是 PANEL_HOST 非 127.0.0.1 —— 而 README 推荐的 nginx 反代
 * 让进程仍监听 127.0.0.1,于是公网实例可以用仓库默认串伪造 admin JWT。
 */
const MISSING_ENV_FILE = path.join(tmpdir(), 'singray-no-such-env-file');

async function loadConfigWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import('../src/config.js');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
}

describe('config weak-secret guard', () => {
  afterEach(() => vi.resetModules());

  it('refuses the example placeholder even when listening on loopback', async () => {
    await expect(
      loadConfigWith({
        PANEL_ENV_FILE: MISSING_ENV_FILE,
        PANEL_HOST: '127.0.0.1',
        PANEL_JWT_SECRET: 'change-me-openssl-rand-hex-32',
        PANEL_APP_SECRET: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/拒绝启动/);
  });

  it('refuses the built-in dev secret', async () => {
    await expect(
      loadConfigWith({
        PANEL_ENV_FILE: MISSING_ENV_FILE,
        PANEL_JWT_SECRET: 'dev-only-change-me',
        PANEL_APP_SECRET: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/拒绝启动/);
  });

  it('accepts real secrets', async () => {
    const mod = await loadConfigWith({
      PANEL_ENV_FILE: MISSING_ENV_FILE,
      PANEL_JWT_SECRET: 'c'.repeat(64),
      PANEL_APP_SECRET: 'd'.repeat(64),
    });
    expect(mod.config.jwtSecret).toBe('c'.repeat(64));
  });
});
