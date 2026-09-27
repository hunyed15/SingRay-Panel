// 待部署状态:节点/证书变更 → 标记机器脏;部署成功 → 按核心清除。
// 驱动服务器页"有未下发变更"横幅(P1-1)。

import type { DatabaseSync } from 'node:sqlite';

export type DeployCore = 'singbox' | 'xray';

export function markDirty(db: DatabaseSync, serverId: number, core: DeployCore): void {
  db.prepare(
    `INSERT INTO pending_deploys (server_id, singbox, xray) VALUES (?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       singbox = max(singbox, ?), xray = max(xray, ?),
       marked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(serverId, core === 'singbox' ? 1 : 0, core === 'xray' ? 1 : 0, core === 'singbox' ? 1 : 0, core === 'xray' ? 1 : 0);
}

export function clearDirtyCore(db: DatabaseSync, serverId: number, core: DeployCore): void {
  db.prepare(`UPDATE pending_deploys SET ${core === 'singbox' ? 'singbox' : 'xray'} = 0 WHERE server_id = ?`).run(serverId);
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
