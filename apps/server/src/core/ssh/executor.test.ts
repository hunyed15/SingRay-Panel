import { describe, it, expect } from 'vitest';
import { buildConn, buildExecCmd, SshExecError, TIMEOUT_DEFAULTS_MS, testConnection, type ExecFn, type SshConn } from './executor.js';

const serverRow = {
  id: 1,
  host: '10.0.0.1',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_auth_type: 'key' as const,
  ssh_auth_secret: 'enc-secret',
  ssh_sudo: 0,
};

describe('ssh executor pure logic', () => {
  it('buildConn picks key vs password and decrypts secret', () => {
    const key = buildConn(serverRow, () => 'RAW_KEY');
    expect(key).toMatchObject({ host: '10.0.0.1', privateKey: 'RAW_KEY', sudo: false });
    const pw = buildConn({ ...serverRow, ssh_auth_type: 'password', ssh_sudo: 1 }, () => 'RAW_PW');
    expect(pw).toMatchObject({ password: 'RAW_PW', sudo: true });
  });

  it('buildExecCmd wraps in sudo shell and escapes single quotes', () => {
    expect(buildExecCmd({ sudo: false }, 'echo hi')).toBe('echo hi');
    expect(buildExecCmd({ sudo: true }, "echo 'hi' && x=1")).toBe("sudo -n -- sh -c 'echo '\\''hi'\\'' && x=1'");
  });

  it('timeout classes: install > config > quick, explicit override wins', async () => {
    expect(TIMEOUT_DEFAULTS_MS.install).toBeGreaterThan(TIMEOUT_DEFAULTS_MS.config);
    expect(TIMEOUT_DEFAULTS_MS.config).toBeGreaterThan(TIMEOUT_DEFAULTS_MS.quick);

    let captured: number | undefined;
    const probe: ExecFn = (_conn, _cmd, opts) => {
      captured = opts?.timeoutMs ?? TIMEOUT_DEFAULTS_MS[opts?.timeoutClass ?? 'config'];
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const conn = buildConn(serverRow, () => 'k');
    await probe(conn, 'x', { timeoutClass: 'install' });
    expect(captured).toBe(TIMEOUT_DEFAULTS_MS.install);
    await probe(conn, 'x', { timeoutClass: 'install', timeoutMs: 1 });
    expect(captured).toBe(1);
  });

  it('testConnection reports structured failure message', async () => {
    const fail: ExecFn = () => Promise.reject(new SshExecError('permission denied', 'echo ok', 126, 'permission denied'));
    const r = await testConnection(buildConn(serverRow, () => 'k'), fail);
    expect(r).toEqual({ ok: false, message: '[exit 126] permission denied' });
    const ok: ExecFn = () => Promise.resolve({ stdout: 'ok\n', stderr: '' });
    expect(await testConnection(buildConn(serverRow, () => 'k'), ok)).toEqual({ ok: true, message: 'ok' });
  });

  it('SshExecError carries cmd and exit code', () => {
    const e = new SshExecError('boom', 'ls /nope', 2, 'ls: cannot access');
    expect(e.exitCode).toBe(2);
    expect(e.cmd).toContain('ls /nope');
    expect(e.stderr).toContain('cannot access');
  });
});
