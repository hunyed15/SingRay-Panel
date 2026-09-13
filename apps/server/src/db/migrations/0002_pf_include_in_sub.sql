-- 0002: port_forwards.include_in_sub — 勾选的启用中转规则进入订阅
-- (链接形态 = 入口机地址 + 入口端口 + 落地节点参数;协议参数仍取自落地机)

ALTER TABLE port_forwards ADD COLUMN include_in_sub INTEGER NOT NULL DEFAULT 0;
