import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../db/client.js';
import { encryptSecret } from '../../services/creds.js';
import { syncTopology } from './sync.js';
import type { ForwardSpec } from '../forward/index.js';

/** 桩:记录下发的规则,不真的连 SSH */
function stubApply() {
  const applied: ForwardSpec[] = [];
  const apply = async (_conn: unknown, spec: ForwardSpec) => {
    applied.push(spec);
  };
  return { applied, apply: apply as never };
}

function seed(db: DatabaseSync) {
  const cred = encryptSecret('test-key');
  db.prepare(
    `INSERT INTO servers (id, name, role, host, control, ssh_auth_secret, ip_stack, relay_mechanism)
     VALUES (1,'relay','relay','1.1.1.1','ssh',?, 'v4', 'socat')`,
  ).run(cred);
  db.prepare(
    `INSERT INTO servers (id, name, role, host, control, ssh_auth_secret, ip_stack)
     VALUES (2,'landing','landing','2.2.2.2','ssh',?, 'v4')`,
  ).run(cred);
  db.prepare("INSERT INTO nodes (name, server_id, protocol, listen_port) VALUES ('n1', 2, 'vless', 31001)").run();
}

describe('topology sync: 落库按条兜底,不再整轮抛穿', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    migrate(db);
    seed(db);
  });

  it('UNIQUE 冲突记入 errors 并落 job_runs(旧实现抛穿 → recordRun 永不执行)', async () => {
    // 手工规则先占了 relay 的 31001(同一入口机同一端口)
    db.prepare(
      `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, auto)
       VALUES ('手工规则', 1, 2, 'port', 0, 31001, 443, 'socat', 0)`,
    ).run();
    const { applied, apply } = stubApply();

    const r = await syncTopology(db, apply);

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/UNIQUE/);
    expect(applied).toHaveLength(0); // 冲突条目不会下发到机器
    const run = db.prepare("SELECT ok, detail FROM job_runs WHERE job = 'topology' ORDER BY id DESC LIMIT 1").get() as
      | { ok: number; detail: string }
      | undefined;
    expect(run?.ok).toBe(0);
    // 自动规则没有留下半截行
    expect((db.prepare('SELECT COUNT(*) c FROM port_forwards WHERE auto = 1').get() as { c: number }).c).toBe(0);
  });

  it('正常路径:建规则 + 下发 + 记账 ok', async () => {
    const { applied, apply } = stubApply();
    const r = await syncTopology(db, apply);
    expect(r).toMatchObject({ created: 1, applied: 1, errors: [] });
    expect(applied[0]).toMatchObject({ entryPort: 31001, landingHost: '2.2.2.2' });
    const run = db.prepare("SELECT ok FROM job_runs WHERE job = 'topology' ORDER BY id DESC LIMIT 1").get() as { ok: number };
    expect(run.ok).toBe(1);
  });

  it('机器侧下发失败 → 回删该行、其余继续、错误可见', async () => {
    const apply = (async () => {
      throw new Error('socat 不可用');
    }) as never;
    const r = await syncTopology(db, apply);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('socat 不可用');
    expect((db.prepare('SELECT COUNT(*) c FROM port_forwards').get() as { c: number }).c).toBe(0);
    const run = db.prepare("SELECT ok FROM job_runs WHERE job = 'topology' ORDER BY id DESC LIMIT 1").get() as { ok: number };
    expect(run.ok).toBe(0);
  });
});
