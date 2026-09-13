import { describe, it, expect } from 'vitest';
import { deployCore, type DeployStep } from './index.js';
import type { ExecFn, SshConn } from '../ssh/executor.js';

const conn: SshConn = { serverId: 1, host: '10.0.0.1', sudo: false, readyTimeout: 5000 };

/** scripted mock: handlers keyed by substring, first match wins; default ok */
function scripted(handlers: { match: string; run?: () => Promise<void>; stdout?: string }[] = []) {
  const calls: string[] = [];
  const execFn: ExecFn = async (_c, cmd) => {
    calls.push(cmd);
    const h = handlers.find((x) => cmd.includes(x.match));
    if (h?.run) await h.run();
    return { stdout: h?.stdout ?? '', stderr: '' };
  };
  const writeFileFn = async (_c: SshConn, path: string, content: string) => {
    calls.push(`writeFile:${path}:${content.length}`);
  };
  return { calls, execFn, writeFileFn };
}

const stepNames = (steps: DeployStep[]) => steps.map((s) => s.step);

describe('deploy engine (transactional)', () => {
  it('singbox happy path: verify via check, reload, health active', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, {
      core: 'singbox',
      config: { log: {} },
      execFn,
      writeFileFn,
    });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toEqual(['render', 'upload', 'verify', 'backup', 'swap', 'restart', 'health']);
    expect(calls.some((c) => c.includes('/usr/local/bin/sing-box check -c'))).toBe(true);
    expect(calls.some((c) => c.includes('systemctl reload sing-box'))).toBe(true);
    expect(calls.some((c) => c.startsWith('writeFile:/tmp/singray-singbox/config.json:'))).toBe(true);
  }, 20000);

  it('xray skips local verify, uses restart, health active', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, {
      core: 'xray',
      config: { log: {} },
      execFn,
      writeFileFn,
    });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toEqual(['render', 'upload', 'verify-skip', 'backup', 'swap', 'restart', 'health']);
    expect(calls.some((c) => c.includes('systemctl restart xray'))).toBe(true);
  }, 20000);

  it('verify failure (before swap) fails without rollback and production untouched', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'sing-box check', run: async () => { throw new Error('invalid json: unknown field network'); } },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(r.error).toContain('unknown field network');
    expect(calls.some((c) => c.includes('systemctl reload'))).toBe(false);
    expect(calls.some((c) => c.includes('install -m 600'))).toBe(false);
  }, 20000);

  it('reload failure after swap rolls back to .bak and restarts old config', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'systemctl reload sing-box', run: async () => { throw new Error('job failed'); } },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    const swapIdx = calls.findIndex((c) => c.includes('install -m 600'));
    expect(swapIdx).toBeGreaterThan(-1);
    const rollbackIdx = calls.findIndex((c) => c.includes('config.json.bak /etc/sing-box/config.json'));
    expect(rollbackIdx).toBeGreaterThan(swapIdx);
  }, 20000);

  it('health-fail collects journal, rolls back (AC4 regression: deploy must not lie OK)', async () => {
    const { execFn, writeFileFn } = scripted([
      { match: 'is-active', stdout: 'inactive\n' }, // never active
      { match: 'journalctl', stdout: 'xray: failed to parse config\nFATAL: run failed' },
    ]);
    const r = await deployCore(conn, { core: 'xray', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.journal).toContain('failed to parse config');
    expect(r.error).toContain('未进入 active');
  }, 30000);

  it('reload "not applicable" falls back to restart (old units without ExecReload)', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'systemctl reload sing-box', run: async () => { throw new Error('Job type reload is not applicable for unit sing-box.service'); } },
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toContain('restart-fallback');
    expect(calls.some((c) => c.includes('systemctl restart sing-box'))).toBe(true);
  }, 20000);
});
