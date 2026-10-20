-- 0014: 部署审计 —— 部署结果不再只活在内存里(进程重启/超 1 小时就没了)
CREATE TABLE IF NOT EXISTS deploy_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  server_name TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deploy_audits_server ON deploy_audits(server_id, id DESC);
