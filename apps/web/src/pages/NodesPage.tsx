import React, { useMemo, useState } from 'react';
import { Alert, App, Badge, Button, Flex, Input, Popconfirm, Switch, Table, Tag, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SafetyOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { NodeItem, NodeTestResult, Server, SniItem } from '../services/types';
import { useAsyncData } from '../hooks/useAsyncData';
import { NodeCreateModal } from '../components/NodeCreateModal';
import { NodeEditModal } from '../components/NodeEditModal';
import { SniLibraryModal } from '../components/SniLibraryModal';
import { EmptyState } from '../components/EmptyState';
import { isNodeOnline, PROTOCOL_META } from '../utils/status';

/**
 * SingBox 节点列表(模板制节点):新建(11 模板)、启停、删除、测速、复制分享链接。
 * 节点「在线」为前端派生(启用 且 入口机在线);配置变更后需在服务器页「部署全部」下发。
 */
export function NodesPage() {
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [editing, setEditing] = useState<NodeItem | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, NodeTestResult>>({});

  const { data, loading, error, reload } = useAsyncData(async () => {
    const [nodes, servers, snis] = await Promise.all([
      api.getNodes(),
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

  const handleToggle = async (node: NodeItem, enabled: boolean) => {
    setToggling(node.id);
    try {
      await api.updateNode(node.id, { enabled });
      if (enabled) {
        message.success(`已启用 ${node.name}(需「部署全部」下发)`);
      } else {
        message.success(`已停用 ${node.name}`);
      }
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async (node: NodeItem) => {
    try {
      await api.deleteNode(node.id);
      message.success(`已删除节点 ${node.name}`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    }
  };

  const handleCopyLink = async (node: NodeItem) => {
    if (!node.share_link) return;
    try {
      await navigator.clipboard.writeText(node.share_link);
      message.success(`已复制 ${node.name} 的分享链接`);
    } catch {
      message.error('复制失败,请手动选择复制');
    }
  };

  const handleTest = async (node: NodeItem) => {
    setTestingId(node.id);
    try {
      const res = await api.testNode(node.id);
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
  const columns: ColumnsType<NodeItem> = [
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
      filters: [...new Set(nodes.map((n) => n.protocol))].map((p) => ({ text: PROTOCOL_META[p as keyof typeof PROTOCOL_META]?.text ?? p, value: p })),
      onFilter: (v, r) => r.protocol === v,
      render: (protocol: NodeItem['protocol']) => (
        <Tag color={PROTOCOL_META[protocol]?.tagColor ?? 'default'}>
          {PROTOCOL_META[protocol]?.text ?? protocol}
        </Tag>
      ),
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
      render: (_, record) => {
        if (record.protocol === 'tunnel') {
          return record.tunnel_address ? (
            <Typography.Text code>
              {record.tunnel_address}:{record.tunnel_port}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          );
        }
        return record.outbound_type === 'direct' ? (
          <Typography.Text type="secondary">直连</Typography.Text>
        ) : (
          <Typography.Text>
            中转 <Typography.Text type="secondary">→</Typography.Text> {record.landing_name ?? '-'}
          </Typography.Text>
        );
      },
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
      render: (_, record) => {
        if (record.protocol === 'tunnel') {
          return <Typography.Text type="secondary">端口转发</Typography.Text>;
        }
        return record.share_link ? (
          <Button type="link" icon={<CopyOutlined />} onClick={() => handleCopyLink(record)}>
            复制
          </Button>
        ) : (
          <Typography.Text type="secondary">走订阅</Typography.Text>
        );
      },
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
          Singbox 节点
        </Typography.Title>
        <Flex gap={8}>
          <Input.Search
            allowClear
            placeholder="按名称搜索"
            style={{ width: 220 }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          />
          <Button icon={<SafetyOutlined />} onClick={() => setLibOpen(true)}>
            Reality 域名库
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建节点
          </Button>
        </Flex>
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

      <Table<NodeItem>
        rowKey="id"
        columns={columns}
        dataSource={filteredNodes}
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        locale={{
          emptyText: (
            <EmptyState
              description="还没有节点。选择模板一键创建:端口、凭据、Reality 密钥、自签证书全部自动生成。"
              action={
                <Button type="primary" onClick={() => setCreateOpen(true)}>
                  新建节点
                </Button>
              }
            />
          ),
        }}
      />

      <NodeCreateModal
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

      <NodeEditModal
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

      <SniLibraryModal
        open={libOpen}
        snis={snis}
        onClose={() => setLibOpen(false)}
        onChanged={reload}
      />
    </Flex>
  );
}
