// 认证:login 签发 JWT(12h),me/account 需已通过全局 onRequest 校验
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { HttpError } from '../services/errors.js';
import { findUserByUsername, findUserById, verifyPassword, updateAccount } from '../services/users.js';

// jwt payload/user 形状(全局声明,仅此文件用到 req.user)
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: number; username: string };
    user: { sub: number; username: string };
  }
}

const loginSchema = z.object({
  username: z.string().min(1, 'username 必填'),
  password: z.string().min(1, 'password 必填'),
});

const accountSchema = z.object({
  username: z.string().optional(),
  oldPassword: z.string().min(1, 'oldPassword 必填'),
  newPassword: z.string().optional(),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', async (req) => {
    const b = loginSchema.parse(req.body);
    const db = getDb();
    const row = findUserByUsername(db, b.username);
    if (!row || !(await verifyPassword(b.password, row.password_hash))) {
      throw new HttpError(401, '用户名或密码错误');
    }
    const token = app.jwt.sign({ sub: row.id, username: row.username }, { expiresIn: '12h' });
    return { token, username: row.username };
  });

  app.get('/me', async (req) => {
    const db = getDb();
    const row = findUserById(db, req.user.sub);
    if (!row) throw new HttpError(401, 'unauthorized');
    return { username: row.username };
  });

  app.put('/account', async (req) => {
    const b = accountSchema.parse(req.body);
    const db = getDb();
    return updateAccount(db, req.user.sub, b);
  });
}
