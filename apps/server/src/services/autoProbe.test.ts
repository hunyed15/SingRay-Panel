// 自动可用性探测:目标收集(含"实际入口是中转机"的判定)与结果落库
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { collectProbeTargets, probeAllNodes, listProbes } from './autoProbe.js';

function seed() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (id,name,role,control,host,client_host) VALUES (1,'L','landing','ssh','10.0.0.1','land.example.com')").run();
  db.prepare("INSERT INTO servers (id,name,role,control,host) VALUES (2,'R','relay','ssh','10.0.0.2')").run();
  db.prepare("INSERT INTO nodes (id,name,server_id,protocol,listen_port,sni,enabled) VALUES (1,'n1',1,'vless',30001,'a.example.com',1)").run();
  db.prepare("INSERT INTO nodes (id,name,server_id,protocol,listen_port,enabled) VALUES (2,'n2',1,'socks',30002,1)").run(); // socks 不进订阅,不探测
  return db;
}

describe('autoProbe', () => {
  it('探测目标是"用户实际连的入口":有 include_in_sub 规则时连中转机', () => {
    const db = seed();
    db.prepare(
      `INSERT INTO port_forwards (id,name,entry_server_id,landing_server_id,target_node_type,target_node_id,entry_port,target_port,mechanism,include_in_sub)
       VALUES (1,'K转L',2,1,'singbox',1,32679,30001,'socat',1)`,
    ).run();

    const targets = collectProbeTargets(db);
    expect(targets).toHaveLength(1); // socks 被排除
    expect(targets[0]).toMatchObject({
      nodeType: 'singbox',
      nodeId: 1,
      host: '10.0.0.2', // 中转机 IP,不是落地机
      port: 32679,
      mode: 'tls',
      via: 'K转L',
    });
    db.close();
  });

  it('没有中转规则时连节点自己所在机器的 client_host', () => {
    const db = seed();
    const targets = collectProbeTargets(db);
    expect(targets[0]).toMatchObject({ host: 'land.example.com', port: 30001, via: undefined });
    db.close();
  });

  it('探测结果落库,重复探测只更新一行', async () => {
    const db = seed();
    let calls = 0;
    const probe = async () => {
      calls++;
      return { ok: true, latency_ms: 42, detail: 'TCP connected' };
    };
    const r1 = await probeAllNodes(db, { probe });
    expect(r1).toMatchObject({ checked: 1, ok: 1, failed: 0 });
    await probeAllNodes(db, { probe });
    expect(calls).toBe(2);

    const rows = listProbes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeType: 'singbox', nodeId: 1, nodeName: 'n1', ok: true, latencyMs: 42 });
    db.close();
  });

  it('探测失败也落库(带原因,便于在界面显示)', async () => {
    const db = seed();
    await probeAllNodes(db, {
      probe: async () => ({ ok: false, latency_ms: null, detail: 'connect ECONNREFUSED' }),
    });
    expect(listProbes(db)[0]).toMatchObject({ ok: false, detail: 'connect ECONNREFUSED' });
    db.close();
  });
});
