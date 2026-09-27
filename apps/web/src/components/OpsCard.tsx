import { App, Button, Card, Flex, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import { DatabaseOutlined, SafetyOutlined } from '@ant-design/icons';
import * as api from '../services/api';
import { useAsyncData } from '../hooks/useAsyncData';

/** 运维卡片(设置页):调度任务状态、数据库备份、手动触发 */
export function OpsCard() {
  const { message } = App.useApp();
  const { data, loading, reload } = useAsyncData(async () => api.getSystemStatus());
  const [busy, setBusy] = useState<string | null>(null);
  const status = data;

  const run = async (key: 'backup' | 'health') => {
    setBusy(key);
    try {
      if (key === 'backup') {
        const r = await api.runBackupNow();
        message.success(`备份完成: ${r.file}`);
      } else {
        const r = await api.runHealthCheckNow();
        message.info(r.summary);
      }
      reload();
    } catch {
      // api 层已提示
    } finally {
      setBusy(null);
    }
  };

  const jobName: Record<string, string> = { backup: '数据库备份', healthcheck: '健康检查', alert: '告警' };

  const runColumns: ColumnsType<api.SystemJobStatus> = [
    { title: '任务', dataIndex: 'name', width: 110, render: (v: string) => jobName[v] ?? v },
    {
      title: '上次运行',
      dataIndex: 'lastAt',
      render: (_, j) =>
        j.lastAt ? (
          <Flex vertical>
            <Typography.Text>{new Date(j.lastAt).toLocaleString('zh-CN')}</Typography.Text>
            <Typography.Text type={j.lastOk ? 'secondary' : 'danger'} style={{ fontSize: 12 }}>
              {j.lastDetail || (j.lastOk ? '成功' : '失败')}
            </Typography.Text>
          </Flex>
        ) : (
          <Typography.Text type="secondary">未运行</Typography.Text>
        ),
    },
    {
      title: '下次',
      dataIndex: 'nextInSec',
      width: 90,
      render: (v: number | null) => (v === null ? '-' : v < 90 ? `${v} 秒内` : `${Math.round(v / 60)} 分钟后`),
    },
  ];

  const backupColumns: ColumnsType<api.BackupFileInfo> = [
    { title: '文件', dataIndex: 'file', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    {
      title: '大小',
      dataIndex: 'size',
      width: 90,
      render: (v: number) => `${(v / 1024).toFixed(0)} KB`,
    },
    {
      title: '时间',
      dataIndex: 'mtime',
      width: 150,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
  ];

  return (
    <Card title="运维">
      <Flex vertical gap={12}>
        <Flex gap={8} align="center">
          <Button icon={<DatabaseOutlined />} loading={busy === 'backup'} onClick={() => run('backup')}>
            立即备份
          </Button>
          <Button icon={<SafetyOutlined />} loading={busy === 'health'} onClick={() => run('health')}>
            立即健康检查
          </Button>
          <Typography.Text type="secondary">
            自动备份每日 {String(status?.jobs.find((j) => j.name === 'backup')?.intervalMs ?? 0) !== '0' ? '按配置小时执行' : ''}·保留{' '}
            {status?.backupRetention ?? '-'} 份 · 健康检查每 {status?.healthIntervalMin ?? '-'} 分钟
          </Typography.Text>
        </Flex>

        <Typography.Text strong>调度任务</Typography.Text>
        <Table<api.SystemJobStatus> rowKey="name" columns={runColumns} dataSource={status?.jobs ?? []} pagination={false} size="small" loading={loading} />

        <Typography.Text strong>数据库备份({status?.backups.length ?? 0} 份)</Typography.Text>
        <Table<api.BackupFileInfo> rowKey="file" columns={backupColumns} dataSource={status?.backups ?? []} pagination={false} size="small" loading={loading} />
      </Flex>
    </Card>
  );
}
