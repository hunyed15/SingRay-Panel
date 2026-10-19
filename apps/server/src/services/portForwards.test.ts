import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { encryptSecret } from './creds.js';
import { deleteForward, purgeRulesForNode } from './portForwards.js';
import { resetServerLocks } from './locks.js';

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const cred = encryptSecret('k');
  db.prepare("INSERT INTO servers (id,name,role,host,control,ssh_auth_secret) VALUES (1,'R','relay','1.1.1.1','ssh',?)").run(cred);
  db.prepare("INSERT INTO servers (id,name,role,host,control,ssh_auth_secret) VALUES (2,'L','landing','2.2.2.2','ssh',?)").run(cred);
  db.prepare(
    `INSERT INTO port_forwards (id,name,entry_server_id,landing_server_id,target_node_type,target_node_id,entry_port,target_port,mechanism)
     VALUES (1,'R→L',1,2,'port',0,31001,443,'socat')`,
  ).run();
  return db;
}

const count = (db: DatabaseSync) => (db.prepare('SELECT COUNT(*) c FROM port_forwards').get() as { c: number }).c;

describe('deleteForward (机器侧与 DB 不能各说各话)', () => {
  beforeEach(() => resetServerLocks());

  it('先删机器侧,再删记录', async () => {
    const db = seed();
    const calls: string[] = [];
    await deleteForward(db, 1, async (_c, spec, remove) => {
      calls.push(`${spec.entryPort}:${remove}`);
    });
    expect(calls).toEqual(['31001:true']);
    expect(count(db)).toBe(0);
    db.close();
  });

  it('机器侧删除失败 → 409 且记录保留(旧实现删行还返回 ok)', async () => {
    const db = seed();
    const err = (await deleteForward(db, 1, async () => {
      throw new Error('ssh timeout');
    }).catch((e) => e)) as { status: number; message: string };
    expect(err.status).toBe(409);
    expect(err.message).toContain('记录已保留');
    expect(count(db)).toBe(1);
    db.close();
  });

  it('purgeRulesForNode:清掉指向该节点的规则', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO port_forwards (id,name,entry_server_id,landing_server_id,target_node_type,target_node_id,entry_port,target_port,mechanism)
       VALUES (2,'R→n1',1,2,'singbox',77,31002,20001,'socat')`,
    ).run();
    const seen: number[] = [];
    const r = await purgeRulesForNode(db, 'singbox', 77, async (_c, spec) => {
      seen.push(spec.entryPort);
    });
    expect(r).toEqual({ removed: 1, errors: [] });
    expect(seen).toEqual([31002]);
    // 只删指向该节点的规则,别的规则不动
    expect(count(db)).toBe(1);
    db.close();
  });

  it('purgeRulesForNode:机器侧清不掉时保留规则并报错', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO port_forwards (id,name,entry_server_id,landing_server_id,target_node_type,target_node_id,entry_port,target_port,mechanism)
       VALUES (3,'R→n2',1,2,'singbox',88,31003,20002,'socat')`,
    ).run();
    const r = await purgeRulesForNode(db, 'singbox', 88, async () => {
      throw new Error('ssh timeout');
    });
    expect(r.removed).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('记录已保留');
    expect(count(db)).toBe(2);
    db.close();
  });

  it('规则不存在 → 404', async () => {
    const db = seed();
    const err = (await deleteForward(db, 999, async () => {}).catch((e) => e)) as { status: number };
    expect(err.status).toBe(404);
    db.close();
  });
});
