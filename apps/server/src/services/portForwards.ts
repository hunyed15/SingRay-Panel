// 手工转发规则的删除(含机器侧清理)。
//
// 为什么单独一层:删除请求必须能在没有 SSH 的测试里跑,并且"机器侧失败"要和
// "DB 删了没有"分开判断 —— 旧实现无论如何都删行并返回 ok:true,结果是机器上
// 的转发还在跑、面板却显示已删除(对账只能事后发现)。

import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { serverConn } from './conn.js';
import { withServerLock } from './locks.js';
import { applyForward, type ForwardSpec } from '../core/forward/index.js';
import type { Row } from './row.js';

export type ApplyFn = (
  conn: ReturnType<typeof serverConn>,
  spec: ForwardSpec,
  remove: boolean,
) => Promise<void>;

export async function deleteForward(
  db: DatabaseSync,
  id: number,
  /** 注入点:测试传桩函数,生产用真实 applyForward */
  apply: ApplyFn = (conn, spec, remove) => applyForward(conn, spec, remove),
): Promise<{ ok: true }> {
  const row = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new HttpError(404, '转发规则不存在');

  const entry = db.prepare('SELECT * FROM servers WHERE id = ?').get(row.entry_server_id) as Row | undefined;
  const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(row.landing_server_id) as Row | undefined;

  // 入口机/落地机记录已不在 → 没有可下发的机器,直接清 DB 行
  if (entry && landing) {
    const landingHost = landing.client_host || landing.host;
    try {
      await withServerLock(entry.id, () =>
        apply(
          serverConn(db, entry.id),
          {
            id: row.id,
            entryPort: row.entry_port,
            landingHost,
            targetPort: row.target_port,
            mechanism: row.mechanism,
          },
          true,
        ),
      );
    } catch (err) {
      // 关键:机器侧没删掉就不删记录,否则面板与机器长期不一致且无人知晓
      throw new HttpError(409, `机器侧规则删除失败,记录已保留:${(err as Error).message}`);
    }
  }

  db.prepare('DELETE FROM port_forwards WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * 删除指向某个节点的所有转发规则(节点删除时调用)。
 * 一条失败不影响其余条目,但会把失败原因带回给调用方 —— 机器上残留的转发必须让人看见。
 */
export async function purgeRulesForNode(
  db: DatabaseSync,
  core: 'singbox' | 'xray',
  nodeId: number,
  apply: ApplyFn = (conn, spec, remove) => applyForward(conn, spec, remove),
): Promise<{ removed: number; errors: string[] }> {
  const rows = db
    .prepare('SELECT id FROM port_forwards WHERE target_node_type = ? AND target_node_id = ?')
    .all(core, nodeId) as { id: number }[];
  const errors: string[] = [];
  let removed = 0;
  for (const row of rows) {
    try {
      await deleteForward(db, row.id, apply);
      removed++;
    } catch (err) {
      errors.push(`规则 #${row.id}: ${(err as Error).message}`);
    }
  }
  return { removed, errors };
}
