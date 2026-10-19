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
import { deleteForward } from '../services/portForwards.js';

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
  /** 可用端口白名单(NAT 场景),如 "32679-32699,30000";空串 = 不限制 */
  portAllow: z.string().nullable().optional(),
  /** 改角色会重建凭据,需要显式确认(仅 PUT 有意义) */
  confirmRotateCredentials: z.boolean().optional(),
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
    const db = getDb();
    // 规则行会被 FK CASCADE 静默删掉,但**别的入口机上的 DNAT/socat unit 不会**:
    // 先把"以这台机器为落地"的规则在那些入口机上删掉。清不掉的如实回报,但不阻塞删除
    // —— 删服务器的常见场景就是机器已经没了,不能把人卡死在这里。
    const warnings: string[] = [];
    const rules = db
      .prepare('SELECT id, entry_server_id FROM port_forwards WHERE landing_server_id = ? AND entry_server_id != ?')
      .all(id, id) as { id: number; entry_server_id: number }[];
    for (const r of rules) {
      try {
        await deleteForward(db, r.id);
      } catch (err) {
        warnings.push(`规则 #${r.id} 在机器 #${r.entry_server_id} 上的转发未清理:${(err as Error).message}`);
      }
    }
    deleteServer(db, id);
    return { ok: true, warnings };
  });

  app.post('/:id/test', async (req) => {
    const { id } = idParam.parse(req.params);
    return testServer(getDb(), id);
  });
}
