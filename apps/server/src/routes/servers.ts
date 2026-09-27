// 服务器 CRUD + SSH 连通性测试
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  listServers,
  createServer,
  updateServer,
  deleteServer,
  testServer,
} from '../services/servers.js';

const createSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  role: z.enum(['relay', 'landing'], { message: 'role 必填(relay/landing)' }),
  control: z.enum(['ssh', 'agent']).optional(),
  host: z.string().optional(),
  clientHost: z.string().optional(),
  sshPort: z.coerce.number().int().optional(),
  sshUser: z.string().optional(),
  sshAuthType: z.enum(['key', 'password']).optional(),
  sshAuthSecret: z.string().optional(),
  sshSudo: z.boolean().optional(),
  region: z.string().optional(),
  /** SSH 跳板机(经它隧道连接);null = 清空(直连) */
  jumpServerId: z.coerce.number().int().nullable().optional(),
  /** 作为中转入口时的转发机制偏好 */
  relayMechanism: z.enum(['iptables', 'socat']).optional(),
  /** 两跳中转时的中间跳机器(落地机用);null = 清空(引擎自选) */
  preferViaServerId: z.coerce.number().int().nullable().optional(),
});

const updateSchema = createSchema.partial();

const idParam = z.object({ id: z.coerce.number().int() });

export default async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listServers(getDb()));

  app.post('/', async (req) => createServer(getDb(), createSchema.parse(req.body)));

  app.put('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return updateServer(getDb(), id, updateSchema.parse(req.body));
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteServer(getDb(), id);
    return { ok: true };
  });

  app.post('/:id/test', async (req) => {
    const { id } = idParam.parse(req.params);
    return testServer(getDb(), id);
  });
}
