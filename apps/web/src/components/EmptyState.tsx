import { Empty, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  description: string;
  action?: ReactNode;
}

/** 列表空态(antd 6 的 Empty 为无 props 组件,空态文案/操作需组合) */
export function EmptyState({ description, action }: EmptyStateProps) {
  return (
    <Flex vertical align="center" gap={8} style={{ padding: '32px 0' }}>
      <Empty />
      <Typography.Text type="secondary">{description}</Typography.Text>
      {action}
    </Flex>
  );
}
