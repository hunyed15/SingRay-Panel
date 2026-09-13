// 单管理员账号:bootstrap、登录校验、在线改用户名/密码(移植自旧 db.js ensureAdmin + auth.js)
import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { HttpError } from './errors.js';
import { getSetting, setSetting } from './settings.js';
import { genRandomHex } from '../core/crypto.js';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function findUserByUsername(db: DatabaseSync, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow | undefined;
}

export function findUserById(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
}

export function ensureAdmin(db: DatabaseSync, admin: { username: string; passwordHash: string }): void {
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)').run(
    admin.username,
    admin.passwordHash,
    new Date().toISOString(),
  );
}

/** 启动时引导:users 表为空才创建(仅首次,PANEL_ADMIN_USER/PANEL_ADMIN_PASSWORD 或默认 admin/admin888);顺带生成订阅 slug */
export async function bootstrapAdmin(db: DatabaseSync): Promise<void> {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!existing) {
    const username = process.env.PANEL_ADMIN_USER || 'admin';
    const password = process.env.PANEL_ADMIN_PASSWORD || 'admin888';
    const passwordHash = await hashPassword(password);
    ensureAdmin(db, { username, passwordHash });
    if (!process.env.PANEL_ADMIN_PASSWORD) {
      console.log(`[bootstrap] admin: ${username}  password: ${password}`);
    }
  }
  if (!getSetting(db, 'sub_slug')) setSetting(db, 'sub_slug', genRandomHex(6));
}

export interface AccountUpdateInput {
  username?: string;
  oldPassword: string;
  newPassword?: string;
}

/** 在线修改管理员用户名/密码;旧密码错误返回 400(输入问题,非会话失效) */
export async function updateAccount(db: DatabaseSync, userId: number, b: AccountUpdateInput): Promise<{ username: string }> {
  const row = findUserById(db, userId);
  if (!row) throw new HttpError(401, 'unauthorized');
  if (!(await verifyPassword(b.oldPassword || '', row.password_hash))) {
    throw new HttpError(400, '当前密码错误');
  }
  let nextUsername = row.username;
  if (b.username !== undefined && String(b.username).trim() !== row.username) {
    const uname = String(b.username).trim();
    if (!uname) throw new HttpError(400, '用户名不能为空');
    const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(uname, row.id);
    if (dup) throw new HttpError(409, '用户名已存在');
    nextUsername = uname;
  }
  if (b.newPassword !== undefined && String(b.newPassword) !== '') {
    const pw = String(b.newPassword);
    if (pw.length < 6) throw new HttpError(400, '新密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(pw), row.id);
  }
  if (nextUsername !== row.username) {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nextUsername, row.id);
  }
  return { username: nextUsername };
}
