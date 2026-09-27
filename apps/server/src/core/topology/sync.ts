// 拓扑同步器:计算期望规则 → 增删 DB 规则 → 在机器上应用 socat/iptables。
// 触发:节点/机器变更后调用 syncTopology(db)(后台执行)。

import type { DatabaseSync } from 'node:sqlite';
import { diffRules, loadMachines, loadRelayableNodes, planTopology, type DesiredRule } from './plan.js';
import { serverConn } from '../../services/conn.js';
import { applyForward } from '../forward/index.js';
import { recordRun } from '../alerts.js';
import type { Row } from '../../services/row.js';

export interface SyncResult {
  created: number;
  deleted: number;
  applied: number;
  errors: string[];
}

/** 单条期望规则落地到机器(创建) */
async function applyDesired(db: DatabaseSync, d: DesiredRule): Promise<void> {
  const entry = db.prepare('SELECT * FROM servers WHERE id = ?').get(d.entryServerId) as Row;
  const landing = db.prepare('SELECT * FROM servers WHERE id = ?').get(d.landingServerId) as Row;
  const conn = serverConn(db, d.entryServerId);
  const landingHost = landing.client_host || landing.host;
  await applyForward(
    conn,
    { id: 0 /* 应用前先用临时 id,落库后再以真实 id 重建标签 */, entryPort: d.entryPort, landingHost, targetPort: d.targetPort, mechanism: d.mechanism },
    false,
  );
  void entry;
}

/** 删除机器侧规则 */
async function removeRule(
  db: DatabaseSync,
  r: { entryServerId: number; entryPort: number; landingServerId: number; targetPort: number },
): Promise<void> {
  const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(r.landingServerId) as Row | undefined;
  if (!landing) return;
  const conn = serverConn(db, r.entryServerId);
  const landingHost = landing.client_host || landing.host;
  const mech = (db.prepare('SELECT relay_mechanism FROM servers WHERE id = ?').get(r.entryServerId) as Row | undefined)?.relay_mechanism ?? 'socat';
  try {
    await applyForward(conn, { id: 0, entryPort: r.entryPort, landingHost, targetPort: r.targetPort, mechanism: mech }, true);
  } catch {
    // 机器侧删除失败不阻断 DB 清理(可用对账发现残留)
  }
}

/**
 * 同步拓扑:计算期望 → 删除多余 auto 规则 → 创建缺失规则(含机器侧应用)。
 * 幂等:重复调用无副作用。
 */
export async function syncTopology(db: DatabaseSync): Promise<SyncResult> {
  const machines = loadMachines(db);
  const nodes = loadRelayableNodes(db);
  const desired = planTopology(machines, nodes);
  const { toCreate, toDelete } = diffRules(db, desired);
  const errors: string[] = [];

  // 1. 删除不再需要的 auto 规则
  for (const r of toDelete) {
    await removeRule(db, r);
    db.prepare('DELETE FROM port_forwards WHERE id = ?').run(r.id);
  }

  // 2. 创建缺失规则:先落库拿真实 id(标签用),再应用机器侧
  let applied = 0;
  for (const d of toCreate) {
    const info = db
      .prepare(
        `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub, auto, note)
         VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
      )
      .run(d.name, d.entryServerId, d.landingServerId, d.targetNodeType, d.targetNodeId, d.entryPort, d.targetPort, d.mechanism, d.includeInSub ? 1 : 0, d.via ? `自动中转(${d.via})` : '自动中转');
    const rowId = Number(info.lastInsertRowid);
    try {
      const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(d.landingServerId) as Row;
      const conn = serverConn(db, d.entryServerId);
      const landingHost = landing.client_host || landing.host;
      await applyForward(conn, { id: rowId, entryPort: d.entryPort, landingHost, targetPort: d.targetPort, mechanism: d.mechanism }, false);
      applied++;
    } catch (err) {
      errors.push(`${d.name}: ${(err as Error).message.slice(0, 100)}`);
      db.prepare('DELETE FROM port_forwards WHERE id = ?').run(rowId); // 应用失败回删记录
    }
  }

  const summary = `新增 ${toCreate.length}(应用 ${applied}) 删除 ${toDelete.length}${errors.length ? ` 失败 ${errors.length}` : ''}`;
  recordRun(db, 'topology', errors.length === 0, summary);
  return { created: toCreate.length, deleted: toDelete.length, applied, errors };
}
