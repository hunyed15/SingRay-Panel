import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { MIGRATIONS } from '../db/migrations.js';

describe('baseline migration', () => {
  it('loads at least one migration file', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('applies cleanly on a fresh database and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['servers', 'nodes', 'xray_nodes', 'port_forwards', 'settings', 'users', 'sni_library', 'relay_settings', 'landing_settings', 'xray_server_settings', 'schema_migrations']) {
      expect(tables).toContain(t);
    }
    // port_forwards must have the explicit mechanism column
    const cols = db.prepare('PRAGMA table_info(port_forwards)').all().map((c) => (c as { name: string }).name);
    expect(cols).toContain('mechanism');
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});
