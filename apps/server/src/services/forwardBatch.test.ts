import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { encryptSecret } from './creds.js';
import { planBatchForward, executeBatchForward, type BatchInput, type BatchPlan } from './forwardBatch.js';

interface Fixture {
  db: DatabaseSync;
  /** 入口机 NAT-A(白名单 32679-32681) */
  natEntry: number;
  /** 无白名单的入口机 FREE-R */
  freeEntry: number;
  /** 落地机 L */
  landing: number;
}

function fixture(): Fixture {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const secret = encryptSecret('test-secret');
  const addServer = (name: string, role: string, host: string, portAllow = '', mech = 'socat'): number => {
    const info = db
      .prepare(
        `INSERT INTO servers (name, role, host, client_host, ssh_auth_type, ssh_auth_secret, relay_mechanism, port_allow, ip_stack)
         VALUES (?,?,?,?,'key',?,?,?,'v4')`,
      )
      .run(name, role, host, '', secret, mech, portAllow);
    return Number(info.lastInsertRowid);
  };

  const natEntry = addServer('NAT-A', 'relay', '10.0.0.1', '32679-32681');
  const freeEntry = addServer('FREE-R', 'relay', '10.0.0.2', '', 'iptables');
  const landing = addServer('LAND', 'landing', '10.0.0.9');

  const addNode = (table: 'nodes' | 'xray_nodes', name: string, protocol: string, port: number, serverId = landing, enabled = 1): number => {
    const info = db
      .prepare(`INSERT INTO ${table} (name, server_id, protocol, listen_port, enabled) VALUES (?,?,?,?,?)`)
      .run(name, serverId, protocol, port, enabled);
    return Number(info.lastInsertRowid);
  };

  addNode('nodes', 'vless-1', 'vless', 20001);
  addNode('nodes', 'vless-2', 'vmess', 20002);
  addNode('nodes', 'socks-1', 'socks', 20003);
  addNode('nodes', 'tunnel-1', 'tunnel', 20004);
  addNode('nodes', 'off-1', 'vless', 20005, landing, 0);
  addNode('xray_nodes', 'xr-1', 'vless', 20006);

  return { db, natEntry, freeEntry, landing };
}

describe('forward batch: planning', () => {
  it('assigns whitelist ports in order and skips unrelayable / disabled / local nodes', () => {
    const f = fixture();
    const plan = planBatchForward(f.db, {
      entryServerIds: [f.natEntry],
      targets: [
        { type: 'singbox', id: 1 }, // vless
        { type: 'singbox', id: 2 }, // vmess
        { type: 'singbox', id: 3 }, // socks → skip
        { type: 'singbox', id: 4 }, // tunnel → skip
        { type: 'singbox', id: 5 }, // disabled → skip
        { type: 'xray', id: 1 }, // vless (xray 表)
      ],
    });
    const created = plan.items.filter((i) => i.action === 'create');
    expect(created.map((i) => i.entryPort)).toEqual([32679, 32680, 32681]);
    expect(plan.createCount).toBe(3);
    expect(plan.skipCount).toBe(3);

    const skipped = plan.items.filter((i) => i.action === 'skip');
    expect(skipped.map((i) => i.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('socks'),
        expect.stringContaining('tunnel'),
        expect.stringContaining('已禁用'),
      ]),
    );
    f.db.close();
  });

  it('skips with a clear reason when the whitelist is exhausted', () => {
    const f = fixture();
    f.db.prepare("UPDATE servers SET port_allow = '32679' WHERE id = ?").run(f.natEntry);
    const plan = planBatchForward(f.db, {
      entryServerIds: [f.natEntry],
      targets: [
        { type: 'singbox', id: 1 },
        { type: 'singbox', id: 2 },
      ],
    });
    expect(plan.createCount).toBe(1);
    expect(plan.items.find((i) => i.action === 'skip')?.reason).toContain('可用端口已用尽');
    f.db.close();
  });

  it('skips the node when it lives on the entry machine itself', () => {
    const f = fixture();
    const localNode = f.db
      .prepare("INSERT INTO nodes (name, server_id, protocol, listen_port, enabled) VALUES ('local','" + f.natEntry + "','vless',20010,1)")
      .run();
    const plan = planBatchForward(f.db, {
      entryServerIds: [f.natEntry],
      targets: [{ type: 'singbox', id: Number(localNode.lastInsertRowid) }],
    });
    expect(plan.items[0]).toMatchObject({ action: 'skip', reason: '节点就在该入口机上,无需中转' });
    f.db.close();
  });

  it('skips a node that already has a rule on that entry machine', () => {
    const f = fixture();
    f.db
      .prepare(
        `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism)
         VALUES ('existing', ?, ?, 'singbox', 1, 32679, 20001, 'socat')`,
      )
      .run(f.natEntry, f.landing);
    const plan = planBatchForward(f.db, { entryServerIds: [f.natEntry], targets: [{ type: 'singbox', id: 1 }] });
    expect(plan.items[0]).toMatchObject({ action: 'skip', reason: '该入口机已有此节点的中转规则' });
    f.db.close();
  });

  it('follows the entry machine mechanism unless overridden', () => {
    const f = fixture();
    const auto = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }] });
    expect(auto.items[0].mechanism).toBe('iptables'); // 该机偏好 iptables
    const forced = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }], mechanism: 'socat' });
    expect(forced.items[0].mechanism).toBe('socat');
    f.db.close();
  });

  it('unrestricted entry machine gets a random port outside the used set', () => {
    const f = fixture();
    const plan = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }] });
    const port = plan.items[0].entryPort!;
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(65000);
    // 不应撞上节点端口(全局唯一)
    expect([20001, 20002, 20003, 20004, 20005, 20006]).not.toContain(port);
    f.db.close();
  });

  it('rejects an empty selection', () => {
    const f = fixture();
    expect(() => planBatchForward(f.db, { entryServerIds: [], targets: [] } as BatchInput)).toThrow(/入口机/);
    expect(() => planBatchForward(f.db, { entryServerIds: [f.natEntry], targets: [] } as BatchInput)).toThrow(/落地节点/);
    f.db.close();
  });

  it('two entry machines each allocate from their own whitelist', () => {
    const f = fixture();
    f.db.prepare("UPDATE servers SET port_allow = '32690-32691' WHERE id = ?").run(f.freeEntry);
    const plan = planBatchForward(f.db, {
      entryServerIds: [f.natEntry, f.freeEntry],
      targets: [{ type: 'singbox', id: 1 }],
    });
    expect(plan.items.map((i) => i.entryPort)).toEqual([32679, 32690]);
    f.db.close();
  });
});

describe('forward batch: execution', () => {
  it('inserts rows and reports per-item machine-side failures (rolled back)', async () => {
    const f = fixture();
    const applied: { port: number; target: number }[] = [];
    const result = await executeBatchForward(
      f.db,
      {
        entryServerIds: [f.natEntry],
        targets: [
          { type: 'singbox', id: 1 },
          { type: 'singbox', id: 2 },
        ],
        includeInSub: true,
      },
      async (_conn, spec) => {
        if (spec.entryPort === 32680) throw new Error('socat not available');
        applied.push({ port: spec.entryPort, target: spec.targetPort });
      },
    );

    expect(applied).toEqual([{ port: 32679, target: 20001 }]);
    expect(result.created).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('socat not available');

    // 失败的那条已回滚,DB 里只剩成功的一条
    const rows = f.db.prepare('SELECT name, entry_port, include_in_sub, core, auto, note FROM port_forwards').all() as {
      name: string;
      entry_port: number;
      include_in_sub: number;
      core: string;
      auto: number;
      note: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_port: 32679, include_in_sub: 1, core: 'singbox', auto: 0, note: '一键添加' });
    f.db.close();
  });
});

describe('forward batch: 预览端口 = 创建端口(P1-14)', () => {
  it('无白名单入口机:两次计划一致,且与实际创建的一致', async () => {
    const f = fixture();
    const input: BatchInput = {
      entryServerIds: [f.freeEntry],
      targets: [{ type: 'singbox', id: 1 }, { type: 'xray', id: 1 }],
    };
    const portsOf = (p: BatchPlan) => p.items.filter((i) => i.action === 'create').map((i) => i.entryPort);
    const first = portsOf(planBatchForward(f.db, input));
    const second = portsOf(planBatchForward(f.db, input));
    expect(first).toHaveLength(2);
    expect(second).toEqual(first); // 旧实现两次都是 Math.random,必然不同

    const applied: number[] = [];
    const r = await executeBatchForward(f.db, input, async (_c, spec) => {
      applied.push(spec.entryPort);
    });
    expect(applied).toEqual(first);
    expect(r.created).toHaveLength(2);
    f.db.close();
  });
});

describe('forward batch: 可达性(P1-13)', () => {
  it('v4-only 入口机 x v6-only 落地机 → 跳过并说明要走两跳', () => {
    const f = fixture();
    f.db.prepare("UPDATE servers SET host = '2607:8140::1', ip_stack = 'v6' WHERE id = ?").run(f.landing);
    const plan = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }] });
    expect(plan.createCount).toBe(0);
    expect(plan.items[0].reason).toContain('两跳');
    f.db.close();
  });

  it('落地机是域名时不按字面判族(可能解析到 v6),不误拦', () => {
    const f = fixture();
    f.db.prepare("UPDATE servers SET host = 'edge.example.com' WHERE id = ?").run(f.landing);
    f.db.prepare("UPDATE servers SET ip_stack = 'v6' WHERE id = ?").run(f.freeEntry);
    const plan = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }] });
    expect(plan.createCount).toBe(1);
    f.db.close();
  });

  it('栈未知(老数据)不拦,避免把正常创建全挡掉', () => {
    const f = fixture();
    f.db.prepare("UPDATE servers SET ip_stack = 'unknown' WHERE id = ?").run(f.freeEntry);
    const plan = planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets: [{ type: 'singbox', id: 1 }] });
    expect(plan.createCount).toBe(1);
    f.db.close();
  });
});

describe('forward batch: 端口用尽文案(P1-15)', () => {
  it('列出占用端口的规则,并说明端口号全链路共享', () => {
    const f = fixture();
    f.db
      .prepare(
        `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, auto)
         VALUES ('手工', ?, ?, 'port', 0, 32679, 443, 'socat', 0)`,
      )
      .run(f.natEntry, f.landing);
    const plan = planBatchForward(f.db, {
      entryServerIds: [f.natEntry],
      targets: [{ type: 'singbox', id: 1 }, { type: 'singbox', id: 2 }, { type: 'xray', id: 1 }],
    });
    expect(plan.createCount).toBe(2); // 32679 被占,只剩 32680/32681
    const skipped = plan.items.find((i) => i.action === 'skip');
    expect(skipped?.reason).toContain('32679(NAT-A 的中转规则)');
    expect(skipped?.reason).toContain('全链路共享');
    f.db.close();
  });
});

describe('forward batch: 落库失败不整批抛穿(F-01)', () => {
  it('INSERT 抛错 → 记入 errors,其余条目继续,不留半截行', async () => {
    const f = fixture();
    // 模拟并发抢到同一 (entry, port):第二条 INSERT 直接 ABORT
    f.db.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON port_forwards WHEN NEW.entry_port = 32680
       BEGIN SELECT RAISE(ABORT, 'UNIQUE race'); END;`,
    );
    const applied: number[] = [];
    const r = await executeBatchForward(
      f.db,
      {
        entryServerIds: [f.natEntry],
        targets: [{ type: 'singbox', id: 1 }, { type: 'singbox', id: 2 }, { type: 'xray', id: 1 }],
      },
      async (_c, spec) => {
        applied.push(spec.entryPort);
      },
    );
    expect(r.created).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('UNIQUE race');
    expect(applied).toEqual([32679, 32681]); // 失败那条没有下发
    expect((f.db.prepare('SELECT COUNT(*) c FROM port_forwards').get() as { c: number }).c).toBe(2);
    f.db.close();
  });
});

describe('forward batch: 总量闸门(F-04)', () => {
  it('计划超过 50 条直接 400,而不是挂几个小时', () => {
    const f = fixture();
    const stmt = f.db.prepare("INSERT INTO nodes (name, server_id, protocol, listen_port) VALUES (?, ?, 'vless', ?)");
    for (let i = 0; i < 60; i++) stmt.run(`bulk-${i}`, f.landing, 21000 + i);
    const targets = Array.from({ length: 60 }, (_, i) => ({ type: 'singbox' as const, id: i + 7 }));
    expect(() => planBatchForward(f.db, { entryServerIds: [f.freeEntry], targets })).toThrow(/一次最多创建 50 条/);
    f.db.close();
  });
});