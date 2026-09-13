// SNI 域名库
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { listSnis, createSni, updateSni, deleteSni } from '../services/snis.js';

const createSchema = z.object({
  domain: z.string().min(1, 'domain 必填'),
  note: z.string().optional(),
});

const updateSchema = z.object({
  domain: z.string().optional(),
  note: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int() });

export default async function sniRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listSnis(getDb()));

  app.post('/', async (req) => {
    const b = createSchema.parse(req.body);
    return createSni(getDb(), b.domain, b.note);
  });

  app.put('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return updateSni(getDb(), id, updateSchema.parse(req.body));
  });

  app.delete('/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    deleteSni(getDb(), id);
    return { ok: true };
  });
}
