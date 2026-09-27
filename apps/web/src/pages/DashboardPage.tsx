import { Alert, Button, Card, Col, Flex, Row, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatBytes } from '../utils/format';
import { MECHANISM_META } from '../utils/status';

/**
 * 首页 Dashboard:机器健康 / 待部署 / 今日流量(按节点) / 最近告警。
 * 数据来自 /api/traffic/dashboard 聚合接口。
 */
export function DashboardPage() {
  const { data, loading, error, reload } = useAsyncData(async () => api.getDashboard());

  const nodeColumns: ColumnsType<api.TrafficNodeRow> = [
    { title: '节点', dataIndex: 'nodeName', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: '机器', dataIndex: 'serverName', width: 110 },
    {
      title: '核心',
      dataIndex: 'core',
      width: 90,
      render: (v: 'singbox' | 'xray') => <Tag color={v === 'singbox' ? 'geekblue' : 'blue'}>{v === 'singbox' ? 'sing-box' : 'xray'}</Tag>,
    },
    { title: '上行', dataIndex: 'up', width: 100, align: 'right', render: (v: number) => formatBytes(v) },
    { title: '下行', dataIndex: 'down', width: 100, align: 'right', render: (v: number) => formatBytes(v) },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          首页
        </Typography.Title>
        <Button onClick={reload} loading={loading}>
          刷新
        </Button>
      </Flex>

      {error && (
        <Alert
          type="error"
          showIcon
          message="加载失败"
          description={error}
          action={
            <Button size="small" onClick={reload}>
              重试
            </Button>
          }
        />
      )}

      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="机器在线" value={data?.machines.online ?? '-'} suffix={`/ ${data?.machines.total ?? '-'}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="待部署机器"
              value={data?.pendingDeploys.length ?? 0}
              valueStyle={(data?.pendingDeploys.length ?? 0) > 0 ? { color: '#d46b08' } : undefined}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="今日上行" value={formatBytes(data?.traffic.totalUp)} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="今日下行" value={formatBytes(data?.traffic.totalDown)} />
          </Card>
        </Col>
      </Row>

      {data && data.pendingDeploys.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${data.pendingDeploys.length} 台机器有未下发的变更: ${data.pendingDeploys.map((p) => p.name).join('、')}`}
          action={
            <Button size="small" type="primary" onClick={() => (window.location.href = '/servers')}>
              去部署
            </Button>
          }
        />
      )}

      <Card size="small" title={`今日流量(按节点, ${data?.traffic.date ?? '-'})`}>
        <Table<api.TrafficNodeRow>
          rowKey={(r) => `${r.serverName}-${r.nodeName}-${r.tag}`}
          columns={nodeColumns}
          dataSource={data?.traffic.top ?? []}
          pagination={false}
          size="small"
          loading={loading}
          locale={{ emptyText: '今日暂无流量数据(统计配置需部署后生效,采集每 5 分钟一轮)' }}
        />
      </Card>

      <Card size="small" title="最近告警">
        {data && data.alerts.length > 0 ? (
          <Flex vertical gap={4}>
            {data.alerts.map((a, i) => (
              <Typography.Text key={i}>
                <Typography.Text type="secondary">[{new Date(a.at).toLocaleString('zh-CN')}]</Typography.Text> {a.detail}
              </Typography.Text>
            ))}
          </Flex>
        ) : (
          <Typography.Text type="secondary">
            暂无告警(健康检查每 {5} 分钟运行,状态变化时告警;{data?.tgConfigured ? '已接入 Telegram 推送' : 'Telegram 未配置,告警仅落库'})
          </Typography.Text>
        )}
      </Card>
    </Flex>
  );
}
