// Xray 节点 CRUD + 启停 + 清空
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  listXrayNodes,
  getXrayNode,
  createXrayNode,
  updateXrayNode,
  toggleXrayNode,
  deleteXrayNode,
  purgeXrayNodes,
} from '../services/xray_nodes.js';

const createSchema = z.object({
  template: z.string().min(1, 'template 必填'),
  name: z.string().min(1, 'name 必填'),
  serverId: z.coerce.number().int(),
  outboundType: z.enum(['direct', 'relay']).optional(),
  landingServerId: z.coerce.number().int().optional(),
  port: z.coerce.number().int().optional(),
  sni: z.string().optional(),
  flow: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().optional(),
  protocol: z.string().optional(),
  port: z.coerce.number().int().optional(),
  enabled: z.boolean().optional(),
  sni: z.string().optional(),
  flow: z.string().optional(),
  outboundType: z.enum(['direct', 'relay']).optional(),
  landingServerId: z.coerce.number().int().optional(),
  note: z.string().optional(),
  authUser: z.string().optional(),
  authPassword: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int() });

export default async function xrayNodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listXrayNodes(getDb()));

  app.post('/', async (req) => createXrayNode(getDb(), createSchema.parse(req.body)));

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return getXrayNode(getDb(), id);
  });

  app.put('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return updateXrayNode(getDb(), id, updateSchema.parse(req.body));
  });

  app.post('/:id/toggle', async (req) => {
    const { id } = idParam.parse(req.params);
    return toggleXrayNode(getDb(), id);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteXrayNode(getDb(), id);
    return { ok: true };
  });

  // 清空所有 xray 节点(不触发部署)
  app.post('/purge', async (req) => {
    const b = z.object({ keepId: z.coerce.number().int().optional() }).parse(req.body ?? {});
    const deleted = purgeXrayNodes(getDb(), b.keepId ?? 0);
    return { ok: true, deleted };
  });
}
