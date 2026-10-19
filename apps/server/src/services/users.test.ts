import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { bootstrapAdmin, findUserByUsername, verifyPassword } from './users.js';

/** 管理员口令:不再有固定默认值(旧实现是 admin888) */
describe('bootstrapAdmin password policy', () => {
  const original = process.env.PANEL_ADMIN_PASSWORD;
  afterEach(() => {
    if (original === undefined) delete process.env.PANEL_ADMIN_PASSWORD;
    else process.env.PANEL_ADMIN_PASSWORD = original;
  });

  it('generates a random password when none is configured (no admin888)', async () => {
    delete process.env.PANEL_ADMIN_PASSWORD;
    // 防止本机 .env 干扰
    process.env.PANEL_ENV_FILE = process.env.PANEL_ENV_FILE || '';
    const db = new DatabaseSync(':memory:');
    migrate(db);

    const r = await bootstrapAdmin(db);
    expect(r.generatedPassword).toBeTruthy();
    expect(r.generatedPassword).toMatch(/^[A-Za-z0-9]{16}$/);

    const row = findUserByUsername(db, 'admin');
    expect(row).toBeDefined();
    expect(await verifyPassword(r.generatedPassword as string, row!.password_hash)).toBe(true);
    // 关键回归:默认口令不能再登录
    expect(await verifyPassword('admin888', row!.password_hash)).toBe(false);
    db.close();
  });

  it('uses an explicitly configured password and reports no generated one', async () => {
    process.env.PANEL_ADMIN_PASSWORD = 'configured-pass-123';
    const db = new DatabaseSync(':memory:');
    migrate(db);

    const r = await bootstrapAdmin(db);
    expect(r.generatedPassword).toBeUndefined();
    const row = findUserByUsername(db, 'admin');
    expect(await verifyPassword('configured-pass-123', row!.password_hash)).toBe(true);
    db.close();
  });
});
