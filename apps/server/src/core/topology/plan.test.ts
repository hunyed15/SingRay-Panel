import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../db/client.js';
import { canReach, resolvePath, planTopology, hostFamily, loadRelayableNodes, type MachineRef, type NodeRef } from './plan.js';

// 与生产一致的拓扑
const M = (over: Partial<MachineRef> & { id: number; name: string }): MachineRef => ({
  host: '1.1.1.1', clientHost: 'x.example.com', role: 'landing', ipStack: 'v4', relayMechanism: 'socat', ...over,
});

const machines: MachineRef[] = [
  M({ id: 1, name: 'Dedirock', host: '173.254.213.226', role: 'landing', ipStack: 'v4' }),
  M({ id: 2, name: 'JP', host: '2607:8140:212:122::', role: 'landing', ipStack: 'v6' }),
  M({ id: 3, name: 'Oracle', host: '140.238.15.122', role: 'landing', ipStack: 'dual' }),
  M({ id: 4, name: 'CDT', host: '8.210.172.76', role: 'relay', ipStack: 'v4' }),
  M({ id: 5, name: 'Hytron', host: '82.47.33.57', role: 'landing', ipStack: 'dual' }),
];

const byId = (id: number) => machines.find((m) => m.id === id)!;

describe('topology: reachability', () => {
  it('hostFamily detects v4/v6 literal', () => {
    expect(hostFamily('1.2.3.4')).toBe('v4');
    expect(hostFamily('2607:8140::1')).toBe('v6');
  });

  it('v4-only relay cannot reach v6-only landing, dual can', () => {
    expect(canReach('v4', '2607:8140::1')).toBe(false);
    expect(canReach('dual', '2607:8140::1')).toBe(true);
    expect(canReach('v6', '1.2.3.4')).toBe(false);
    expect(canReach('dual', '1.2.3.4')).toBe(true);
  });

  it('unknown stack → no reach (safe default)', () => {
    expect(canReach('unknown', '1.2.3.4')).toBe(false);
    expect(canReach('unknown', '2607::1')).toBe(false);
  });
});

describe('topology: path resolution', () => {
  it('direct path when families match (v4 relay → v4 landing)', () => {
    expect(resolvePath(byId(4), byId(1), machines)).toEqual([4, 1]);
  });

  it('two-hop via dual machine when relay cannot reach landing (v4 relay → v6 landing)', () => {
    // CDT(v4) → JP(v6):need dual intermediate. Oracle(3) 与 Hytron(5) 都 dual,
    // 取 all 中第一个满足的 → Oracle(3)
    expect(resolvePath(byId(4), byId(2), machines)).toEqual([4, 3, 2]);
  });

  it('dual relay reaches both v4 and v6 landings directly', () => {
    expect(resolvePath(byId(3), byId(1), machines)).toEqual([3, 1]);
    expect(resolvePath(byId(3), byId(2), machines)).toEqual([3, 2]);
  });

  it('no path when no dual candidate exists', () => {
    const noDual = machines.map((m) => (m.id === 3 || m.id === 5 ? { ...m, ipStack: 'v4' as const } : m));
    expect(resolvePath(noDual.find((m) => m.id === 4)!, noDual.find((m) => m.id === 2)!, noDual)).toBeNull();
  });

  it('self is not a path', () => {
    expect(resolvePath(byId(4), byId(4), machines)).toBeNull();
  });
});

describe('topology: rule planning', () => {
  const nodes: NodeRef[] = [
    { id: 10, name: 'Dedirock-vless-reality-xray', type: 'xray', serverId: 1, port: 30001 },
    { id: 11, name: 'JP-vless-reality-xray', type: 'xray', serverId: 2, port: 30002 },
  ];

  it('v4 landing gets a single-hop rule; v6 landing gets two-hop rules', () => {
    const rules = planTopology(machines, nodes);
    // Dedirock(v4) 经 CDT 一跳
    const d = rules.find((r) => r.name === 'CDT→Dedirock-vless-reality-xray');
    expect(d).toBeDefined();
    expect(d).toMatchObject({ entryServerId: 4, landingServerId: 1, entryPort: 30001, targetPort: 30001, includeInSub: true, targetNodeType: 'xray' });

    // JP(v6) 经 CDT → Oracle(dual) → JP:两跳
    const hop1 = rules.find((r) => r.name === 'CDT→JP-vless-reality-xray');
    expect(hop1).toMatchObject({ entryServerId: 4, landingServerId: 3, entryPort: 30002, targetPort: 30002, includeInSub: false, targetNodeType: 'port' });
    const hop2 = rules.find((r) => r.name === 'Oracle→JP-vless-reality-xray');
    expect(hop2).toMatchObject({ entryServerId: 3, landingServerId: 2, entryPort: 30002, targetPort: 30002, includeInSub: true, targetNodeType: 'xray' });
  });

  it('uses the same port number along the whole chain (no manual planning)', () => {
    const rules = planTopology(machines, nodes);
    for (const r of rules) expect(r.entryPort).toBe(r.targetPort);
    // 每个节点的端口在其链路各跳一致
    const jp = rules.filter((r) => r.name.includes('JP-vless'));
    expect(new Set(jp.map((r) => r.entryPort))).toEqual(new Set([30002]));
  });

  it('dedupes shared intermediate rules (one Oracle→JP rule, not per upstream relay)', () => {
    // 加第二个 relay(v4) → 两条上游规则共用一条中间规则
    const twoRelays = [...machines, M({ id: 6, name: 'CDT2', host: '9.9.9.9', role: 'relay', ipStack: 'v4' })];
    const rules = planTopology(twoRelays, [{ id: 11, name: 'JP-node', type: 'xray', serverId: 2, port: 30002 }]);
    const mid = rules.filter((r) => r.name === 'Oracle→JP-node');
    expect(mid).toHaveLength(1);
    expect(rules.filter((r) => r.entryServerId === 4 || r.entryServerId === 6)).toHaveLength(2);
  });

  it('per-machine mechanism preference is honored', () => {
    const withIptables = machines.map((m) => (m.id === 4 ? { ...m, relayMechanism: 'iptables' as const } : m));
    const rules = planTopology(withIptables, [nodes[0]]);
    expect(rules[0].mechanism).toBe('iptables');
  });

  it('unknown ip_stack machines produce no rules (not guessed)', () => {
    const unknown = machines.map((m) => ({ ...m, ipStack: 'unknown' as const }));
    expect(planTopology(unknown, nodes)).toEqual([]);
  });
});

describe('topology: loadRelayableNodes filter', () => {
  it('excludes tunnel/socks/http, keeps real client protocols', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare("INSERT INTO servers (name, host, role) VALUES ('Landing','1.2.3.4','landing')").run();
    let port = 10000;
    const sb: [string, boolean][] = [['vless', true], ['vmess', true], ['trojan', true], ['hysteria2', true], ['tunnel', false], ['socks', false], ['http', false]];
    for (const [proto, _keep] of sb) {
      db.prepare('INSERT INTO nodes (name, server_id, protocol, listen_port, enabled) VALUES (?, 1, ?, ?, 1)')
        .run(`${proto}-node`, proto, port++);
    }
    for (const proto of ['vless', 'vmess', 'socks', 'http']) {
      db.prepare('INSERT INTO xray_nodes (name, server_id, protocol, listen_port, enabled) VALUES (?, 1, ?, ?, 1)')
        .run(`x-${proto}`, proto, port++);
    }
    const got = loadRelayableNodes(db).map((n) => n.name).sort();
    expect(got).toEqual(['hysteria2-node', 'trojan-node', 'vless-node', 'vmess-node', 'x-vless', 'x-vmess']);
    db.close();
  });
});
