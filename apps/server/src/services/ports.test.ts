import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { HttpError } from './errors.js';
import {
  serverPortRanges,
  isPortAllowedOnServer,
  assertPortAllowedOnServer,
  pickPortFromRanges,
  allocatePortForServer,
} from './ports.js';

const RANGES = [
  { start: 32679, end: 32682 },
  { start: 40000, end: 40000 },
];

/** 建一个最小机器;portAllow 为空 = 不限制 */
function makeDb(portAllow = ''): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (name, host, role, port_allow) VALUES ('NAT-A','10.0.0.9','relay',?)").run(portAllow);
  return db;
}

describe('ports: machine port whitelist', () => {
  it('reads parsed ranges; empty = unrestricted', () => {
    const db = makeDb('32679-32682,40000');
    expect(serverPortRanges(db, 1)).toEqual(RANGES);
    db.prepare("UPDATE servers SET port_allow = '' WHERE id = 1").run();
    expect(serverPortRanges(db, 1)).toEqual([]);
    db.close();
  });

  it('unrestricted machine allows any port', () => {
    const db = makeDb('');
    expect(isPortAllowedOnServer(db, 1, 12345)).toBe(true);
    db.close();
  });

  it('whitelisted machine rejects ports outside the ranges with a helpful message', () => {
    const db = makeDb('32679-32682,40000');
    expect(isPortAllowedOnServer(db, 1, 32680)).toBe(true);
    expect(isPortAllowedOnServer(db, 1, 32683)).toBe(false);
    expect(() => assertPortAllowedOnServer(db, 1, 32682)).not.toThrow();
    // 32683 不在白名单 → 抛 400
    expect(() => assertPortAllowedOnServer(db, 1, 32683, '入口机')).toThrow(HttpError);
    db.close();
  });

  it('error message names the machine role and the allowed ports', () => {
    const db = makeDb('32679-32682');
    try {
      assertPortAllowedOnServer(db, 1, 8080, '入口机');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('入口机的可用端口白名单不含 8080');
      expect((err as Error).message).toContain('32679-32682');
    }
    db.close();
  });
});

describe('ports: allocation inside the whitelist', () => {
  it('picks the lowest free port in the ranges', () => {
    expect(pickPortFromRanges([], RANGES)).toBe(32679);
    expect(pickPortFromRanges([32679, 32680], RANGES)).toBe(32681);
    expect(pickPortFromRanges([32679, 32680, 32681, 32682, 40000], RANGES)).toBeNull();
  });

  it('allocation skips ports already used globally (topology reuses one port per chain)', () => {
    const db = makeDb('32679-32682');
    db.prepare("INSERT INTO servers (name, host, role) VALUES ('L','1.2.3.4','landing')").run();
    // 另一台机器上的节点已占用 32679 → 本机只能拿 32680
    db.prepare("INSERT INTO nodes (name, server_id, protocol, listen_port, enabled) VALUES ('n',2,'vless',32679,1)").run();
    expect(allocatePortForServer(db, 1)).toBe(32680);
    db.close();
  });

  it('throws 400 when the whitelist is exhausted', () => {
    const db = makeDb('32679-32680');
    db.prepare("INSERT INTO servers (name, host, role) VALUES ('L','1.2.3.4','landing')").run();
    db.prepare("INSERT INTO nodes (name, server_id, protocol, listen_port, enabled) VALUES ('a',2,'vless',32679,1)").run();
    db.prepare("INSERT INTO nodes (name, server_id, protocol, listen_port, enabled) VALUES ('b',2,'vless',32680,1)").run();
    expect(() => allocatePortForServer(db, 1)).toThrow(/可用端口已用尽/);
    db.close();
  });

  it('unrestricted machine keeps the legacy random strategy (20000-65000)', () => {
    const db = makeDb('');
    const port = allocatePortForServer(db, 1);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(65000);
    db.close();
  });
});
