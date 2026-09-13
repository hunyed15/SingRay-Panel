// 节点连通性测试(面板本机,原生 net/tls,无 nc/openssl 依赖 — design.md §5)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { HttpError } from '../services/errors.js';
import { probeNode } from '../core/probe/index.js';
import type { Row } from '../services/row.js';

const idParam = z.object({ id: z.coerce.number().int() });

/** TLS 类协议且配置了 SNI → 做握手;其余仅 TCP 端口探测 */
function probeMode(protocol: string, sni: string): 'tcp' | 'tls' {
  return ['vless', 'vmess', 'trojan'].includes(protocol) && !!sni ? 'tls' : 'tcp';
}

export default async function testRoutes(app: FastifyInstance): Promise<void> {
  const probeFromRow = (node: Row) => {
    const db = getDb();
    const srv = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(node.server_id) as Row | undefined;
    if (!srv) throw new HttpError(404, '服务器不存在');
    return probeNode({
      host: srv.client_host || srv.host,
      port: node.listen_port,
      mode: probeMode(node.protocol, node.sni),
      sni: node.sni,
    });
  };

  app.post('/nodes/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const node = getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
    if (!node) throw new HttpError(404, '节点不存在');
    return probeFromRow(node);
  });

  app.post('/xray-nodes/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const node = getDb().prepare('SELECT * FROM xray_nodes WHERE id = ?').get(id) as Row | undefined;
    if (!node) throw new HttpError(404, 'Xray 节点不存在');
    return probeFromRow(node);
  });
}
