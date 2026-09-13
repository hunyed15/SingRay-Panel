// 面板设置:目前只有订阅 slug
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { getSettings, putSettings } from '../services/settings.js';

const putSchema = z.object({
  subSlug: z.string({ message: 'subSlug 必填' }).optional(),
  singboxRealityIp: z.boolean().optional(),
  xrayRealityIp: z.boolean().optional(),
});

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => getSettings(getDb()));

  app.put('/', async (req) => {
    const b = putSchema.parse(req.body);
    return putSettings(getDb(), b);
  });

  // 兼容旧版 POST 语义
  app.post('/', async (req) => {
    const b = putSchema.parse(req.body);
    return putSettings(getDb(), b);
  });
}
