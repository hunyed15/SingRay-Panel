// 端口转发路由。机制由前端显式选择(默认 socat——容器环境实测 iptables DNAT 不可靠)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { HttpError } from '../services/errors.js';
import { decrypt } from '../core/crypto.js';
import { config } from '../config.js';
import { preflight, applyForward, reconcile } from '../core/forward/index.js';
import { serverConn } from '../services/conn.js';
import type { Row } from '../services/row.js';

const createSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  entryServerId: z.coerce.number().int(),
  landingServerId: z.coerce.number().int(),
  targetNodeType: z.enum(['singbox', 'xray']),
  targetNodeId: z.coerce.number().int(),
  entryPort: z.coerce.number().int().optional(),
  targetPort: z.coerce.number().int(),
  mechanism: z.enum(['iptables', 'socat']).default('socat'), // 实测容器环境 iptables DNAT 静默失效,默认 socat
  note: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int() });

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
    const b = z.object({ entryServerId: z.coerce.number().int(), entryPort: z.coerce.number().int() }).parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const conn = serverConn(db, entry.id);
    return preflight(conn, b.entryPort);
  });

  app.post('/', async (req) => {
    const db = getDb();
    const b = createSchema.parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const landing = getServer(db, b.landingServerId);
    const table = b.targetNodeType === 'singbox' ? 'nodes' : 'xray_nodes';
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(b.targetNodeId)) {
      throw new HttpError(400, `目标 ${b.targetNodeType === 'singbox' ? 'SingBox' : 'Xray'} 节点不存在`);
    }
    const port = b.entryPort || 20000 + Math.floor(Math.random() * 40000);
    if (db.prepare('SELECT id FROM port_forwards WHERE entry_server_id = ? AND entry_port = ?').get(b.entryServerId, port)) {
      throw new HttpError(409, `入口端口 ${port} 已被其他转发规则占用`);
    }

    const conn = serverConn(db, entry.id);
    const landingHost = landing.client_host || landing.host;

    // 先落库拿 id(规则的 singray:<id> 标签用于 reconcile 对账),写规则失败则回删
    const info = db.prepare(
      `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, note)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(b.name, b.entryServerId, b.landingServerId, b.targetNodeType, b.targetNodeId, port, b.targetPort, b.mechanism, b.note ?? '');
    const rowId = Number(info.lastInsertRowid);

    try {
      await applyForward(conn, { id: rowId, entryPort: port, landingHost, targetPort: b.targetPort, mechanism: b.mechanism }, false);
    } catch (err) {
      db.prepare('DELETE FROM port_forwards WHERE id = ?').run(rowId);
      throw new HttpError(500, `转发规则写入失败: ${(err as Error).message}`);
    }
    return { port_forward: item(db, db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(rowId) as Row) };
  });

  /** 订阅整合开关(也可扩展更多可编辑字段) */
  app.put('/:id', async (req) => {
    const db = getDb();
    const { id } = idParam.parse(req.params);
    const b = z.object({ includeInSub: z.boolean() }).parse(req.body);
    const info = db.prepare('UPDATE port_forwards SET include_in_sub = ? WHERE id = ?').run(b.includeInSub ? 1 : 0, id);
    if (info.changes === 0) throw new HttpError(404, '转发规则不存在');
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const db = getDb();
    const { id } = idParam.parse(req.params);
    const row = db.prepare('SELECT * FROM port_forwards WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, '转发规则不存在');

    const entry = db.prepare('SELECT * FROM servers WHERE id = ?').get(row.entry_server_id) as Row | undefined;
    if (entry) {
      const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(row.landing_server_id) as Row | undefined;
      if (landing) {
        const conn = serverConn(db, entry.id);
        try {
          await applyForward(
            conn,
            { id: row.id, entryPort: row.entry_port, landingHost: landing.client_host || landing.host, targetPort: row.target_port, mechanism: row.mechanism },
            true,
          );
        } catch (err) {
          // 删除机器侧规则失败不阻断 DB 删除;可用 reconcile 发现残留
          app.log.warn(`[port-forward] delete rule #${id} failed: ${(err as Error).message}`);
        }
      }
    }
    db.prepare('DELETE FROM port_forwards WHERE id = ?').run(id);
    return { ok: true };
  });

  /** 对账:机器实际规则 vs DB(design.md §4 reconcile) */
  app.post('/reconcile', async (req) => {
    const db = getDb();
    const b = z.object({ entryServerId: z.coerce.number().int() }).parse(req.body);
    const entry = getServer(db, b.entryServerId);
    const conn = serverConn(db, entry.id);
    const rules = (db.prepare('SELECT id, mechanism, entry_port FROM port_forwards WHERE entry_server_id = ?').all(b.entryServerId) as Row[]).map((r) => ({
      id: r.id,
      mechanism: r.mechanism,
      entryPort: r.entry_port,
    }));
    return reconcile(conn, rules);
  });
}
