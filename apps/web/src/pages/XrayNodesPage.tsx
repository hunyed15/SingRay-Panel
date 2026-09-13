import { useMemo, useState } from 'react';
import { Alert, App, Badge, Button, Flex, Input, Popconfirm, Switch, Table, Tag, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { NodeTestResult, Server, SniItem, XrayNodeItem } from '../services/types';
import { useAsyncData } from '../hooks/useAsyncData';
import { XrayNodeCreateModal } from '../components/XrayNodeCreateModal';
import { XrayNodeEditModal } from '../components/XrayNodeEditModal';
import { EmptyState } from '../components/EmptyState';
import { isNodeOnline, XRAY_PROTOCOL_META } from '../utils/status';

/**
 * Xray 节点列表(6 协议模板,flow 字段):新建、编辑、启停、删除、测速、复制分享链接。
 */
export function XrayNodesPage() {
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<XrayNodeItem | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, NodeTestResult>>({});

  const { data, loading, error, reload } = useAsyncData(async () => {
    const [nodes, servers, snis] = await Promise.all([
      api.getXrayNodes(),
      api.getServers(),
      api.getSnis(),
    ]);
    return { nodes, servers, snis };
  });

  const nodes = data?.nodes ?? [];
  const servers: Server[] = data?.servers ?? [];
  const snis: SniItem[] = data?.snis ?? [];
  const landings = servers.filter((s) => s.role === 'landing');
  const onlineServerIds = new Set(
    servers.filter((s) => s.ping_status === 'online').map((s) => s.id),
  );

  const handleToggle = async (node: XrayNodeItem, enabled: boolean) => {
    setToggling(node.id);
    try {
      await api.updateXrayNode(node.id, { enabled });
      message.success(enabled ? `已启用 ${node.name}` : `已停用 ${node.name}`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async (node: XrayNodeItem) => {
    try {
      await api.deleteXrayNode(node.id);
      message.success(`已删除节点 ${node.name}`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    }
  };

  const handleCopyLink = async (node: XrayNodeItem) => {
    if (!node.share_link) return;
    try {
      await navigator.clipboard.writeText(node.share_link);
      message.success(`已复制 ${node.name} 的分享链接`);
    } catch {
      message.error('复制失败,请手动选择复制');
    }
  };

  const handleTest = async (node: XrayNodeItem) => {
    setTestingId(node.id);
    try {
      const res = await api.testXrayNode(node.id);
      setTestResults((prev) => ({ ...prev, [node.id]: res }));
    } catch {
      setTestResults((prev) => ({ ...prev, [node.id]: { ok: false, detail: '测试失败' } }));
    } finally {
      setTestingId(null);
    }
  };


  const [search, setSearch] = useState('');
  const filteredNodes = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return kw ? nodes.filter((n) => n.name.toLowerCase().includes(kw)) : nodes;
  }, [nodes, search]);
  const columns: ColumnsType<XrayNodeItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 180,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: '协议',
      dataIndex: 'protocol',
      width: 100,
      filters: [...new Set(nodes.map((n) => n.protocol))].map((p) => ({ text: XRAY_PROTOCOL_META[p as keyof typeof XRAY_PROTOCOL_META]?.text ?? p, value: p })),
      onFilter: (v, r) => r.protocol === v,
      render: (protocol: XrayNodeItem['protocol']) => (
        <Tag color={XRAY_PROTOCOL_META[protocol]?.tagColor ?? 'default'}>
          {XRAY_PROTOCOL_META[protocol]?.text ?? protocol}
        </Tag>
      ),
    },
    {
      title: 'Flow',
      dataIndex: 'flow',
      width: 140,
      render: (value: string | undefined) =>
        value ? <Typography.Text code>{value}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '入口机',
      dataIndex: 'server_name',
      width: 100,
      sorter: (a, b) => a.server_name.localeCompare(b.server_name),
      defaultSortOrder: 'ascend',
      filters: [...new Set(nodes.map((n) => n.server_name))].map((s) => ({ text: s, value: s })),
      onFilter: (v, r) => r.server_name === v,
      render: (value: string) => <Typography.Text>{value}</Typography.Text>,
    },
    {
      title: '端口',
      dataIndex: 'listen_port',
      width: 80,
      sorter: (a, b) => a.listen_port - b.listen_port,
      render: (value: number) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: '出口',
      key: 'outbound',
      width: 160,
      render: (_, record) =>
        record.outbound_type === 'direct' ? (
          <Typography.Text type="secondary">直连</Typography.Text>
        ) : (
          <Typography.Text>
            中转 <Typography.Text type="secondary">→</Typography.Text> {record.landing_name ?? '-'}
          </Typography.Text>
        ),
    },
    {
      title: '状态',
      key: 'online',
      width: 90,
      render: (_, record) =>
        isNodeOnline(record, onlineServerIds) ? (
          <Badge status="success" text="可连" />
        ) : (
          <Badge status="default" text="不可用" />
        ),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 70,
      filters: [
        { text: '已启用', value: 1 },
        { text: '已停用', value: 0 },
      ],
      onFilter: (v, r) => r.enabled === v,
      render: (_, record) => (
        <Switch
          checked={record.enabled === 1}
          loading={toggling === record.id}
          onChange={(checked) => handleToggle(record, checked)}
        />
      ),
    },
    {
      title: '测速',
      key: 'test',
      width: 110,
      render: (_, record) => {
        const tr = testResults[record.id];
        return (
          <Button
            type="link"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={testingId === record.id}
            onClick={() => handleTest(record)}
          >
            {tr ? (tr.ok ? `${tr.latency_ms ?? ''}ms` : '❌') : '测速'}
          </Button>
        );
      },
    },
    {
      title: '分享',
      key: 'share',
      width: 90,
      render: (_, record) =>
        record.share_link ? (
          <Button type="link" icon={<CopyOutlined />} onClick={() => handleCopyLink(record)}>
            复制
          </Button>
        ) : (
          <Typography.Text type="secondary">走订阅</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Flex gap={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(record)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除节点 ${record.name}?`}
            description="删除后移除该入站配置,并从订阅剔除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Xray 节点
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建 Xray 节点
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

      <Table<XrayNodeItem>
        rowKey="id"
        columns={columns}
        dataSource={filteredNodes}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        locale={{
          emptyText: (
            <EmptyState
              description="还没有 Xray 节点。选择模板一键创建:端口、凭据、Reality 密钥、自签证书全部自动生成。"
              action={
                <Button type="primary" onClick={() => setCreateOpen(true)}>
                  新建 Xray 节点
                </Button>
              }
            />
          ),
        }}
      />

      <XrayNodeCreateModal
        open={createOpen}
        servers={servers}
        landings={landings}
        snis={snis}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          reload();
        }}
      />

      <XrayNodeEditModal
        open={editing !== null}
        node={editing}
        landings={landings}
        snis={snis}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </Flex>
  );
}
