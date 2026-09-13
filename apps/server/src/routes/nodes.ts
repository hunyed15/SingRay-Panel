// sing-box 节点 CRUD + 启停
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { listNodes, getNode, createNode, updateNode, toggleNode, deleteNode } from '../services/nodes.js';

const createSchema = z.object({
  template: z.string().min(1, 'template 必填'),
  name: z.string().min(1, 'name 必填'),
  serverId: z.coerce.number().int(),
  outboundType: z.enum(['direct', 'relay']).optional(),
  landingServerId: z.coerce.number().int().optional(),
  port: z.coerce.number().int().optional(),
  sni: z.string().optional(),
  authUser: z.string().optional(),
  authPassword: z.string().optional(),
  tunnelAddress: z.string().optional(),
  tunnelPort: z.coerce.number().int().optional(),
});

const updateSchema = z.object({
  name: z.string().optional(),
  protocol: z.string().optional(),
  port: z.coerce.number().int().optional(),
  enabled: z.boolean().optional(),
  sni: z.string().optional(),
  outboundType: z.enum(['direct', 'relay']).optional(),
  landingServerId: z.coerce.number().int().optional(),
  authUser: z.string().optional(),
  authPassword: z.string().optional(),
  tunnelAddress: z.string().optional(),
  tunnelPort: z.coerce.number().int().optional(),
  note: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int() });

export default async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listNodes(getDb()));

  app.post('/', async (req) => createNode(getDb(), createSchema.parse(req.body)));

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return getNode(getDb(), id);
  });

  app.put('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return updateNode(getDb(), id, updateSchema.parse(req.body));
  });

  app.post('/:id/toggle', async (req) => {
    const { id } = idParam.parse(req.params);
    return toggleNode(getDb(), id);
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteNode(getDb(), id);
    return { ok: true };
  });
}
