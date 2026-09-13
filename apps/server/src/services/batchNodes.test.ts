import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { batchCreateNodes } from './batchNodes.js';

function seedDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (id, name, role, host) VALUES (1, 'Dedirock', 'landing', '1.2.3.4')").run();
  return db;
}

describe('batchCreateNodes', () => {
  it('creates one node per template with convention names and unique ports', () => {
    const db = seedDb();
    const r = batchCreateNodes(db, 1, { core: 'singbox', templates: ['vless-reality', 'vmess-ws-tls', 'trojan-tls'], realitySni: 'dl.google.com' });
    expect(r.created.map((c) => c.name).sort()).toEqual([
      'Dedirock-trojan-tls-sb', 'Dedirock-vless-reality-sb', 'Dedirock-vmess-ws-tls-sb',
    ]);
    const ports = r.created.map((c) => c.port);
    expect(new Set(ports).size).toBe(ports.length); // 端口唯一
    // reality SNI 落库
    const sni = db.prepare("SELECT sni FROM nodes WHERE name = 'Dedirock-vless-reality-sb'").get() as { sni: string };
    expect(sni.sni).toBe('dl.google.com');
  });

  it('skips templates that already exist on the machine (same protocol+tls+transport)', () => {
    const db = seedDb();
    batchCreateNodes(db, 1, { core: 'singbox', templates: ['vless-reality'], realitySni: 'dl.google.com' });
    const r2 = batchCreateNodes(db, 1, { core: 'singbox', templates: ['vless-reality', 'ss2022'], realitySni: 'dl.google.com' });
    expect(r2.created.map((c) => c.name)).toEqual(['Dedirock-ss2022-sb']);
    expect(r2.skipped).toEqual([{ template: 'vless-reality', reason: expect.stringContaining('已存在') }]);
  });

  it('unknown template is skipped, not fatal; empty templates rejected', () => {
    const db = seedDb();
    const r = batchCreateNodes(db, 1, { core: 'xray', templates: ['xray-ss', 'nope'] });
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([{ template: 'nope', reason: '未知模板' }]);
    expect(() => batchCreateNodes(db, 1, { core: 'xray', templates: [] })).toThrow();
  });
});
