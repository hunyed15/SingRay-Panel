import { describe, it, expect } from 'vitest';
import { applyForward, preflight, reconcile, type ForwardSpec } from './index.js';
import type { SshConn, ExecFn } from '../ssh/executor.js';

const conn: SshConn = { serverId: 1, host: '10.0.0.1', sudo: false, readyTimeout: 5000 };
const spec: ForwardSpec = { id: 7, entryPort: 31001, landingHost: '10.0.0.9', targetPort: 41001, mechanism: 'iptables' };

function recordingExec(responses: Record<string, string> = {}) {
  const calls: { cmd: string; opts?: unknown }[] = [];
  const execFn: ExecFn = async (_conn, cmd, opts) => {
    calls.push({ cmd, opts });
    for (const [needle, out] of Object.entries(responses)) {
      if (cmd.includes(needle)) return { stdout: out, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, execFn };
}

describe('forward: iptables (explicit mechanism)', () => {
  it('create writes tagged DNAT + FORWARD rules, persists, enables ip_forward', async () => {
    const { calls, execFn } = recordingExec();
    await applyForward(conn, spec, false, execFn);
    const dnat = calls.find((c) => c.cmd.includes('PREROUTING'));
    expect(dnat!.cmd).toContain('-A PREROUTING -p tcp --dport 31001');
    expect(dnat!.cmd).toContain('--comment singray:7');
    expect(dnat!.cmd).toContain('--to-destination 10.0.0.9:41001');
    expect(calls.some((c) => c.cmd.includes('FORWARD -p tcp -d 10.0.0.9 --dport 41001 -j ACCEPT'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes('iptables-save'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes('ip_forward=1'))).toBe(true);
  });

  it('remove uses -D and still persists', async () => {
    const { calls, execFn } = recordingExec();
    await applyForward(conn, spec, true, execFn);
    expect(calls.find((c) => c.cmd.includes('PREROUTING'))!.cmd).toContain('-D PREROUTING');
  });

  it('socat create writes a systemd unit and enables it (no silent fallback anywhere)', async () => {
    const { calls, execFn } = recordingExec();
    const writes: { path: string; content: string }[] = [];
    await applyForward(
      conn,
      { ...spec, mechanism: 'socat' },
      false,
      execFn,
      async (_conn, path, content) => { writes.push({ path, content }); },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/etc/systemd/system/singray-fwd-31001.service');
    expect(writes[0].content).toContain('ExecStart=/usr/bin/socat TCP-LISTEN:31001');
    expect(writes[0].content).toContain('TCP:10.0.0.9:41001');
    expect(calls.some((c) => c.cmd.includes('systemctl enable --now singray-fwd-31001.service'))).toBe(true);
  });
});

describe('forward: preflight', () => {
  it('collects hard and soft issues explicitly', async () => {
    const { execFn } = recordingExec({
      'command -v iptables': 'NO\n',
      '/proc/sys/net/ipv4/ip_forward': '0\n',
      ":31001 '": 'BUSY\n',
    });
    const r = await preflight(conn, 31001, execFn);
    expect(r.iptablesAvailable).toBe(false);
    expect(r.ipForward).toBe('0');
    expect(r.entryPortBusy).toBe(true);
    expect(r.issues.some((i) => i.includes('iptables'))).toBe(true);
    expect(r.issues.some((i) => i.includes('ip_forward'))).toBe(true);
    expect(r.issues.some((i) => i.includes('已被占用'))).toBe(true);
  });
});

describe('forward: reconcile', () => {
  it('flags missing (db-only) and orphan (machine-only) rules per mechanism', async () => {
    const { execFn } = recordingExec({
      'PREROUTING': '-A PREROUTING -p tcp --dport 31001 -m comment --comment singray:7 -j DNAT --to-destination 10.0.0.9:41001\n-A PREROUTING -p tcp --dport 32000 -m comment --comment singray:99 -j DNAT --to-destination 1.2.3.4:80\n',
      'list-units': 'singray-fwd-33000.service\nsingray-fwd-35000.service\n',
    });
    const r = await reconcile(
      conn,
      [
        { id: 7, mechanism: 'iptables', entryPort: 31001 },   // present
        { id: 8, mechanism: 'iptables', entryPort: 31999 },   // missing on machine
        { mechanism: 'socat', id: 9, entryPort: 33000 },      // present
        { mechanism: 'socat', id: 10, entryPort: 34000 },     // missing
      ],
      execFn,
    );
    expect(r.missingIptables).toEqual([8]);
    expect(r.missingSocat).toEqual([34000]);
    expect(r.orphanIptables).toHaveLength(1);
    expect(r.orphanIptables[0]).toContain('singray:99');
    expect(r.orphanSocat).toEqual(['singray-fwd-35000.service']);
  });
});
