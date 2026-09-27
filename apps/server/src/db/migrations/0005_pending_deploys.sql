-- 0005: 待部署状态跟踪 —— 节点/证书变更后标记机器"有未下发配置",
-- 服务器页横幅提示 + 部署成功后清除(消除"改了节点忘了部署"的黑洞)
CREATE TABLE IF NOT EXISTS pending_deploys (
  server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  singbox INTEGER NOT NULL DEFAULT 0,
  xray INTEGER NOT NULL DEFAULT 0,
  marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
