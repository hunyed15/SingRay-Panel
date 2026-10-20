// 核心生命周期:安装前留上一版二进制、可一键回退(D9-04 后半)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { serverLifecycle } from './lifecycle.js';
import { encryptSecret } from './creds.js';

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare(
    "INSERT INTO servers (id, name, role, control, host, ssh_port, ssh_user, ssh_auth_type, ssh_auth_secret) VALUES (1,'m','relay','ssh','1.2.3.4',22,'root','password',?)",
  ).run(encryptSecret('test-secret'));
  return db;
}

/** 记录所有下发到机器的命令;fail 里命中的命令抛错(模拟执行失败) */
function recorder(fail: RegExp[] = []) {
  const cmds: string[] = [];
  const execFn = (async (_c: unknown, cmd: string) => {
    cmds.push(cmd);
    if (fail.some((re) => re.test(cmd))) throw new Error(`command failed: ${cmd}`);
    return { stdout: '', stderr: '', code: 0 };
  }) as never;
  return { cmds, execFn };
}

const writeFileFn = (async () => {}) as never;

afterEach(() => vi.unstubAllGlobals());

describe('lifecycle: 版本回退点', () => {
  it('安装时把当前二进制留一份 .prev(装坏了能回退)', async () => {
    // 固定版本,别在测试里请求 GitHub
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: 'v1.99.0' }) }) as unknown as Response),
    );
    const db = seed();
    const { cmds, execFn } = recorder();
    await serverLifecycle(db, 1, 'singbox', 'install', { execFn, writeFileFn });
    const installCmd = cmds.find((c) => c.includes('install -m 755'));
    expect(installCmd).toBeTruthy();
    expect(installCmd).toContain('cp -p /usr/local/bin/sing-box /usr/local/bin/sing-box.prev');
    db.close();
  });

  it('回退:交换二进制并重启服务', async () => {
    const db = seed();
    const { cmds, execFn } = recorder();
    const r = await serverLifecycle(db, 1, 'singbox', 'rollback', { execFn, writeFileFn });
    expect(r.ok).toBe(true);
    expect(cmds.some((c) => c.includes('mv -f /usr/local/bin/sing-box /usr/local/bin/sing-box.cur'))).toBe(true);
    expect(cmds.some((c) => c === 'systemctl restart sing-box')).toBe(true);
    db.close();
  });

  it('没有备份(<bin>.prev 不存在)时回退失败,不重启服务', async () => {
    const db = seed();
    const { cmds, execFn } = recorder([/test -x .*\.prev/]);
    await expect(serverLifecycle(db, 1, 'xray', 'rollback', { execFn, writeFileFn })).rejects.toThrow(/test -x/);
    expect(cmds.some((c) => c.startsWith('systemctl restart'))).toBe(false);
    db.close();
  });
});
