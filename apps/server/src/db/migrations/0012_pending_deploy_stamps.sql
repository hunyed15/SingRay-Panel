-- 0012: 待部署标记加"每核心时间戳" —— 布尔无法区分"部署期间新发生的变更",
-- 旧实现部署结束无条件清零,把部署过程中新改的节点一起抹掉(横幅消失而机器跑旧配置)。
ALTER TABLE pending_deploys ADD COLUMN singbox_marked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE pending_deploys ADD COLUMN xray_marked_at TEXT NOT NULL DEFAULT '';
UPDATE pending_deploys SET singbox_marked_at = marked_at WHERE singbox = 1;
UPDATE pending_deploys SET xray_marked_at = marked_at WHERE xray = 1;
