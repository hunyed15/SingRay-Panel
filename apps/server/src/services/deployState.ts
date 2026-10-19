// 待部署状态:节点/证书变更 → 标记机器脏;部署成功 → 按核心清除。
// 驱动服务器页"有未下发变更"横幅(P1-1)。
//
// 清除必须带"部署开始时的标记时间":部署要跑几十秒,期间的变更若被一起清零,
// 横幅会消失而机器跑的仍是旧配置(旧实现的布尔标记就是这个毛病)。

import type { DatabaseSync } from 'node:sqlite';

export type DeployCore = 'singbox' | 'xray';

const stampCol = (core: DeployCore): string => (core === 'singbox' ? 'singbox_marked_at' : 'xray_marked_at');

export function markDirty(db: DatabaseSync, serverId: number, core: DeployCore): void {
  const col = stampCol(core);
  db.prepare(
    `INSERT INTO pending_deploys (server_id, singbox, xray, ${col}) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(server_id) DO UPDATE SET
       singbox = max(singbox, ?), xray = max(xray, ?),
       ${col} = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       marked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(serverId, core === 'singbox' ? 1 : 0, core === 'xray' ? 1 : 0, core === 'singbox' ? 1 : 0, core === 'xray' ? 1 : 0);
}

/** 部署开始前取一次标记时间(没有标记则返回空串) */
export function dirtyStamp(db: DatabaseSync, serverId: number, core: DeployCore): string {
  const row = db
    .prepare(`SELECT ${stampCol(core)} AS ts FROM pending_deploys WHERE server_id = ?`)
    .get(serverId) as { ts: string } | undefined;
  return row?.ts ?? '';
}

/**
 * 部署成功后清除标记;**只有标记时间没变过才清**。
 * 返回 false = 部署期间又有新变更,横幅应继续提示(机器可能需要再部署一次)。
 */
export function clearDirtyCore(db: DatabaseSync, serverId: number, core: DeployCore, stamp: string): boolean {
  const info = db
    .prepare(`UPDATE pending_deploys SET ${core} = 0 WHERE server_id = ? AND ${stampCol(core)} = ?`)
    .run(serverId, stamp);
  return Number(info.changes) > 0;
}

export interface PendingDeploy {
  serverId: number;
  name: string;
  singbox: boolean;
  xray: boolean;
}

export function listPendingDeploys(db: DatabaseSync): PendingDeploy[] {
  return (
    db
      .prepare(
        `SELECT p.server_id, s.name, p.singbox, p.xray
         FROM pending_deploys p JOIN servers s ON s.id = p.server_id
         WHERE p.singbox = 1 OR p.xray = 1
         ORDER BY s.id`,
      )
      .all() as any[]
  ).map((r) => ({ serverId: r.server_id, name: r.name, singbox: r.singbox === 1, xray: r.xray === 1 }));
}
