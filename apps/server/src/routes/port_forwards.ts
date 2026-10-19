// 端口转发路由。机制由前端显式选择(默认 socat——容器环境实测 iptables DNAT 不可靠)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { HttpError } from '../services/errors.js';
import { decrypt } from '../core/crypto.js';
import { config } from '../config.js';
import { preflight, applyForward, reconcile, removeIptablesLine, removeSocatUnit } from '../core/forward/index.js';
import { assertPortAllowedOnServer, assertPortFree, allocatePortForServer } from '../services/ports.js';
import { planBatchForward, executeBatchForward } from '../services/forwardBatch.js';
import { deleteForward } from '../services/portForwards.js';
import { withServerLock } from '../services/locks.js';
import { serverConn } from '../services/conn.js';
import type { Row } from '../services/row.js';

const createSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  entryServerId: z.coerce.number().int(),
  landingServerId: z.coerce.number().int(),
  // 'port' = 纯端口转发(两跳中转的中间跳;不绑定节点,只需 targetPort)
  targetNodeType: z.enum(['singbox', 'xray', 'port']),
  targetNodeId: z.coerce.number().int().optional(),
  entryPort: z.coerce.number().int().optional(),
  targetPort: z.coerce.number().int(),
  mechanism: z.enum(['iptables', 'socat']).default('socat'), // 实测容器环境 iptables DNAT 静默失效,默认 socat
  includeInSub: z.boolean().optional(),
  note: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int() });

/** 一键添加:入口机(多选)× 落地节点(多选) */
const batchSchema = z.object({
  entryServerIds: z.array(z.coerce.number().int()).min(1, '请至少选择一台入口机').max(50),
  targets: z
    .array(z.object({ type: z.enum(['singbox', 'xray']), id: z.coerce.number().int() }))
    .min(1, '请至少选择一个落地节点')
    .max(500),
  mechanism: z.enum(['iptables', 'socat']).optional(),
  includeInSub: z.boolean().optional(),
});

const getServer = (db: ReturnType<typeof getDb>, id: number): Row => {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new HttpError(400, '服务器不存在');
  return row;
};

function item(db: ReturnType<typeof getDb>, row: Row) {
  const entry = db.prepare('SELECT name FROM servers WHERE id = ?').get(row.entry_server_id) as Row | undefined;
  const landing = db.prepare('SELECT name FROM servers WHERE id = ?').get(row.landing_server_id) as Row | undefined;
  const table = row.target_node_type === 'singbox' ? 'nodes' : 'xray_nodes';
  const nd = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(row.target_node_id) as Row | undefined;
  return {
    ...row,
    entry_server_name: entry?.name || '(deleted)',
    landing_server_name: landing?.name || '(deleted)',
    target_node_name: nd?.name || '(deleted)',
  };
}

export default async function portForwardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM port_forwards ORDER BY id').all() as Row[];
    return rows.map((r) => item(db, r));
  });

  /** 新建向导预检:入口机 iptables/ip_forward/端口占用(决定机制选择) */
  app.post('/preflight', async (req) => {
    const db = getDb();
    // entryPort 可省略(NAT 机器留空自动分配)—— 旧 schema 强制必填,导致主路径恒 400 且被前端静默吞掉
    const b = z.object({ entryServerId: z.coerce.number().int(), entryPort: z.coerce.number().int().optional() }).parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const conn = serverConn(db, entry.id);
    return preflight(conn, b.entryPort ?? 0);
  });

  app.post('/', async (req) => {
    const db = getDb();
    const b = createSchema.parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const landing = getServer(db, b.landingServerId);
    // 'port' 模式(两跳中转中间跳)不需要节点;其余模式校验节点存在
    let nodeId = b.targetNodeId ?? 0;
    if (b.targetNodeType !== 'port') {
      const table = b.targetNodeType === 'singbox' ? 'nodes' : 'xray_nodes';
      if (!nodeId || !db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(nodeId)) {
        throw new HttpError(400, `目标 ${b.targetNodeType === 'singbox' ? 'SingBox' : 'Xray'} 节点不存在`);
      }
    }
    // 入口端口:显式指定时必须在入口机的可用端口白名单内(NAT 机器只有部分端口能对外);
    // 留空则按白名单自动分配(无白名单时沿用原有随机策略)
    let port: number;
    if (b.entryPort) {
      port = Number(b.entryPort);
      assertPortAllowedOnServer(db, b.entryServerId, port, '入口机');
      assertPortFree(db, b.entryServerId, port); // 同机节点占用该端口 → iptables 会截走节点流量
      if (db.prepare('SELECT id FROM port_forwards WHERE entry_server_id = ? AND entry_port = ?').get(b.entryServerId, port)) {
        throw new HttpError(409, `入口端口 ${port} 已被其他转发规则占用`);
      }
    } else {
      port = allocatePortForServer(db, b.entryServerId);
    }

    const conn = serverConn(db, entry.id);
    const landingHost = landing.client_host || landing.host;

    // 先落库拿 id(规则的 singray:<id> 标签用于 reconcile 对账),写规则失败则回删
    // core:末跳直接取节点类型;纯端口转发(中间跳)无核归属
    const core = b.targetNodeType === 'port' ? '' : b.targetNodeType;
    const info = db.prepare(
      `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub, core, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(b.name, b.entryServerId, b.landingServerId, b.targetNodeType, nodeId, port, b.targetPort, b.mechanism, b.includeInSub ? 1 : 0, core, b.note ?? '');
    const rowId = Number(info.lastInsertRowid);

    try {
      await applyForward(conn, { id: rowId, entryPort: port, landingHost, targetPort: b.targetPort, mechanism: b.mechanism }, false);
    } catch (err) {
      db.prepare('DELETE FROM port_forwards WHERE id = ?').run(rowId);
      throw new HttpError(500, `转发规则写入失败: ${(err as Error).message}`);
    }
    return { port_forward: item(db, db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(rowId) as Row) };
  });

  /** 一键添加:预览(端口按白名单确定性分配,不落库、不碰机器) */
  app.post('/batch/preview', async (req) => planBatchForward(getDb(), batchSchema.parse(req.body)));

  /** 一键添加:执行(逐条下发,失败条目回滚并单独汇报) */
  app.post('/batch', async (req) => executeBatchForward(getDb(), batchSchema.parse(req.body)));

  /** 订阅整合开关(也可扩展更多可编辑字段) */
  app.put('/:id', async (req) => {
    const db = getDb();
    const { id } = idParam.parse(req.params);
    const b = z.object({ includeInSub: z.boolean() }).parse(req.body);
    const info = db.prepare('UPDATE port_forwards SET include_in_sub = ? WHERE id = ?').run(b.includeInSub ? 1 : 0, id);
    if (info.changes === 0) throw new HttpError(404, '转发规则不存在');
    return { ok: true };
  });

  app.delete('/:id', async (req) => deleteForward(getDb(), idParam.parse(req.params).id));

  /**
   * 对账:机器实际规则 vs DB。
   * fix=true 时顺手修复:缺失的按 DB 行重新下发,孤儿规则/unit 直接清掉。
   */
  app.post('/reconcile', async (req) => {
    const db = getDb();
    const b = z.object({ entryServerId: z.coerce.number().int(), fix: z.boolean().optional() }).parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const rows = db.prepare('SELECT * FROM port_forwards WHERE entry_server_id = ?').all(b.entryServerId) as Row[];
    const conn = serverConn(db, entry.id);
    const report = await reconcile(
      conn,
      rows.map((r) => ({ id: r.id, mechanism: r.mechanism, entryPort: r.entry_port })),
    );
    if (!b.fix) return report;

    const repaired = { reapplied: [] as number[], removed: [] as string[], errors: [] as string[] };
    const byId = new Map(rows.map((r) => [r.id, r]));
    const applyRow = async (row: Row) => {
      const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(row.landing_server_id) as Row | undefined;
      if (!landing) throw new Error(`落地机 #${row.landing_server_id} 不存在`);
      await withServerLock(entry.id, () =>
        applyForward(conn, {
          id: row.id,
          entryPort: row.entry_port,
          landingHost: landing.client_host || landing.host,
          targetPort: row.target_port,
          mechanism: row.mechanism,
        }, false),
      );
      repaired.reapplied.push(row.id);
    };

    for (const id of report.missingIptables) {
      const row = byId.get(id);
      if (!row) continue;
      try {
        await applyRow(row);
      } catch (err) {
        repaired.errors.push(`#${id} 重新下发失败:${(err as Error).message}`);
      }
    }
    for (const port of report.missingSocat) {
      const row = rows.find((r) => r.entry_port === port);
      if (!row) continue;
      try {
        await applyRow(row);
      } catch (err) {
        repaired.errors.push(`#${row.id} 重新下发失败:${(err as Error).message}`);
      }
    }
    for (const line of report.orphanIptables) {
      try {
        await withServerLock(entry.id, () => removeIptablesLine(conn, line));
        repaired.removed.push(line);
      } catch (err) {
        repaired.errors.push(`孤儿 iptables 规则删除失败:${(err as Error).message}`);
      }
    }
    for (const unit of report.orphanSocat) {
      try {
        await withServerLock(entry.id, () => removeSocatUnit(conn, unit));
        repaired.removed.push(unit);
      } catch (err) {
        repaired.errors.push(`孤儿 unit ${unit} 删除失败:${(err as Error).message}`);
      }
    }
    return { ...report, repaired };
  });
}
