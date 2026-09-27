-- 0010: 中转跳板机偏好 + 规则的核标识
-- servers.prefer_via_server_id  落地机指定「中间跳优先走哪台双栈机」;NULL = 引擎自选(候选里第一台)
-- port_forwards.core            规则归属核心(singbox/xray),用于界面按核心筛选;
--                               中间跳('port')按所属链路的核心归并,便于整条链一起筛选

ALTER TABLE servers ADD COLUMN prefer_via_server_id INTEGER;

ALTER TABLE port_forwards ADD COLUMN core TEXT NOT NULL DEFAULT '';

-- 存量回填:末跳直接取节点类型
UPDATE port_forwards SET core = target_node_type WHERE target_node_type IN ('singbox', 'xray');

-- 中间跳:按入口端口对齐同链路的末跳,归并到该链路的核心。
-- 必须 COALESCE:孤立中间跳(无配对末跳,如手工建的纯端口转发)子查询返回 NULL,
-- 而 core 是 NOT NULL —— 直接赋值会让整个迁移回滚、面板无法启动。
UPDATE port_forwards SET core = COALESCE((
  SELECT f2.target_node_type FROM port_forwards f2
  WHERE f2.target_node_type IN ('singbox', 'xray')
    AND f2.entry_port = port_forwards.entry_port
  ORDER BY f2.id
  LIMIT 1
), '')
WHERE target_node_type = 'port';
