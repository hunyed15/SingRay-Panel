-- 0015: 节点可用性探测结果(每个节点一行,存最近一次结果)
CREATE TABLE IF NOT EXISTS node_probes (
  node_type TEXT NOT NULL,          -- singbox | xray
  node_id INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (node_type, node_id)
);
