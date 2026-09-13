// 部署路由:单机双核心/单核心 + 一键部署全部
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { deployAll, deployServerBothCores } from '../services/deployAll.js';

const idParam = z.object({ id: z.coerce.number().int() });
const coreSchema = z.object({ core: z.enum(['singbox', 'xray']).optional() });

export default async function deployRoutes(app: FastifyInstance): Promise<void> {
  /** 一键部署全部(服务器页顶部按钮;并发 ≤3,逐机返回结果) */
  app.post('/all', async () => ({ results: await deployAll(getDb()) }));

  /** 单机部署(body.core 缺省 = sing-box + xray 都部署) */
  app.post('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { core } = coreSchema.parse(req.body ?? {});
    return deployServerBothCores(getDb(), id, undefined, core);
  });
}
