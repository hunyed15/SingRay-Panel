-- 0007: 流量采样(核心 v2ray stats API 的累计计数器快照;今日用量 = 当日快照差分)
CREATE TABLE IF NOT EXISTS traffic_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  core TEXT NOT NULL CHECK(core IN ('singbox','xray')),
  tag TEXT NOT NULL,
  uplink INTEGER NOT NULL DEFAULT 0,
  downlink INTEGER NOT NULL DEFAULT 0,
  sampled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_traffic_samples_key ON traffic_samples(server_id, core, tag, sampled_at);
