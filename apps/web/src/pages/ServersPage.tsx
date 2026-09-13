import { useState } from 'react';
import {
  Alert,
  Dropdown,
  App,
  Badge,
  Button,
  Flex,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { Server } from '../services/types';
import { useAsyncData } from '../hooks/useAsyncData';
import { ServerFormModal } from '../components/ServerFormModal';
import { DeployResultModal } from '../components/DeployResultModal';
import { BatchNodesModal } from '../components/BatchNodesModal';
import { CertModal } from '../components/CertModal';
import { EmptyState } from '../components/EmptyState';
import { formatRelativeTime } from '../utils/format';
import { CONTROL_META, ROLE_META, SERVER_STATUS_META } from '../utils/status';

/**
 * 服务器列表:CRUD + 双核状态(sing-box / xray)+ SSH 连通性测试 + 「部署全部」。
 * 配置变更后在此统一下发到所有机器(每台机器展示 singbox/xray 两个结果)。
 */
export function ServersPage() {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [servers, snis] = await Promise.all([api.getServers(), api.getSnis()]);
    return { servers, snis };
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployResults, setDeployResults] = useState<import('../services/types').DeployAllResult[] | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchServer, setBatchServer] = useState<Server | null>(null);
  const [certOpen, setCertOpen] = useState(false);
  const [certServer, setCertServer] = useState<Server | null>(null);

  const servers = data?.servers ?? [];
  const snis = data?.snis ?? [];

  const handleDeployAll = async () => {
    setDeploying(true);
    try {
      const res = await api.deployAll();
      setDeployResults(res.results ?? []);
      const allOk = (res.results ?? []).every(
        (r) => r.singbox?.ok && (!r.xray || r.xray.ok || r.xray.skipped),
      );
      if (allOk) message.success('全部机器部署完成');
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setDeploying(false);
    }
  };

  const handleDeployOne = async (record: Server) => {
    setBusy(`deploy:${record.id}`);
    try {
      const r = await api.deployServer(record.id);
      setDeployResults([r]);
      const ok = r.singbox?.ok && (!r.xray || r.xray.ok || r.xray.skipped);
      if (ok) message.success(`${record.name} 部署完成`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBusy(null);
    }
  };

  /** 单核心部署(结果仍走结果弹窗,未选核心标记 skip) */
  const handleDeployCore = async (record: Server, core: 'singbox' | 'xray') => {
    setBusy(`deploy:${record.id}`);
    try {
      const r = await api.deployServerCore(record.id, core);
      setDeployResults([r]);
      const coreRes = core === 'singbox' ? r.singbox : r.xray;
      if (coreRes?.ok) message.success(`${record.name} ${core === 'singbox' ? 'sing-box' : 'xray'} 部署完成`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBusy(null);
    }
  };

  /** 安装/重启/卸载(生命周期结果为步骤列表,用消息提示) */
  const handleLifecycle = async (record: Server, core: 'singbox' | 'xray', action: api.LifecycleAction) => {
    const label = `${record.name} ${core === 'singbox' ? 'sing-box' : 'xray'} ${{ install: '安装', restart: '重启', uninstall: '卸载' }[action]}`;
    setBusy(`lifecycle:${record.id}`);
    try {
      const r = await api.serverLifecycle(record.id, core, action);
      if (r.ok) {
        message.success({ content: `${label}成功(${(r.steps ?? []).join(' → ')})`, duration: 6 });
        reload();
      } else {
        message.error({ content: `${label}失败:${r.error ?? '未知原因'}`, duration: 8 });
      }
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBusy(null);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setCreateOpen(true);
  };
  const openEdit = (record: Server) => {
    setEditing(record);
    setCreateOpen(true);
  };
  const closeModal = () => setCreateOpen(false);

  const handleTest = async (record: Server) => {
    setBusy(`test:${record.id}`);
    try {
      const res = await api.testServer(record.id);
      if (res.ok) {
        message.success(`${record.name} SSH 连接正常`);
      } else {
        message.error(`${record.name} 连接失败:${res.message ?? '未知原因'}`);
      }
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (record: Server) => {
    try {
      await api.deleteServer(record.id);
      message.success(`已删除 ${record.name}`);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    }
  };

  const columns: ColumnsType<Server> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 120,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 80,
      render: (role: Server['role']) => (
        <Tag color={ROLE_META[role].tagColor}>{ROLE_META[role].text}</Tag>
      ),
    },
    {
      title: '控制',
      dataIndex: 'control',
      width: 80,
      render: (control: Server['control']) => (
        <Tag color={CONTROL_META[control].tagColor}>{CONTROL_META[control].text}</Tag>
      ),
    },
    {
      title: '地区',
      dataIndex: 'region',
      width: 70,
      render: (value: string) => <Typography.Text type="secondary">{value || '-'}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'ping_status',
      width: 80,
      render: (status: Server['ping_status']) => {
        const meta = SERVER_STATUS_META[status] ?? SERVER_STATUS_META.unknown;
        return <Badge status={meta.status} text={meta.text} />;
      },
    },
    {
      title: 'sing-box',
      dataIndex: 'singbox_version',
      width: 90,
      render: (value: string) => (
        <Typography.Text type="secondary">{value || '-'}</Typography.Text>
      ),
    },
    {
      title: 'xray',
      dataIndex: 'xray_version',
      width: 90,
      render: (value: string) => (
        <Typography.Text type="secondary">{value || '-'}</Typography.Text>
      ),
    },
    {
      title: 'Host',
      key: 'host',
      width: 150,
      ellipsis: true,
      render: (_, record) => (
        <Tooltip
          title={
            record.client_host && record.client_host !== record.host
              ? `SSH: ${record.ssh_user}@${record.host}:${record.ssh_port} · 对外: ${record.client_host}`
              : `${record.ssh_user}@${record.host}:${record.ssh_port}(${record.ssh_auth_type === 'key' ? '私钥' : '密码'})`
          }
        >
          <Typography.Text code>{record.client_host || record.host || '-'}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '最近探测',
      dataIndex: 'last_seen',
      width: 110,
      render: (value: string | null) => (
        <Typography.Text type="secondary">{formatRelativeTime(value)}</Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, record) => (
        <Space size={[4, 0]} wrap>
          {record.control === 'ssh' && (
            <Button
              type="link"
              size="small"
              icon={<ApiOutlined />}
              loading={busy === `test:${record.id}`}
              onClick={() => handleTest(record)}
            >
              测连通
            </Button>
          )}
          {record.control === 'ssh' && (
            <Dropdown
              menu={{
                items: [
                  { key: 'singbox', label: '部署 sing-box' },
                  { key: 'xray', label: '部署 xray' },
                  { type: 'divider' },
                  { key: 'both', label: '部署(两个核心)' },
                ],
                onClick: ({ key }) => {
                  if (key === 'both') void handleDeployOne(record);
                  else void handleDeployCore(record, key as 'singbox' | 'xray');
                },
              }}
            >
              <Button type="link" size="small" icon={<CloudUploadOutlined />} loading={busy === `deploy:${record.id}`}>
                部署
              </Button>
            </Dropdown>
          )}
          {record.control === 'ssh' && (
            <Dropdown
              menu={{
                items: [
                  { type: 'group', label: 'sing-box', children: [
                    { key: 'singbox-install', label: '安装' },
                    { key: 'singbox-restart', label: '重启' },
                    { key: 'singbox-uninstall', label: '卸载', danger: true },
                  ] },
                  { type: 'group', label: 'xray', children: [
                    { key: 'xray-install', label: '安装' },
                    { key: 'xray-restart', label: '重启' },
                    { key: 'xray-uninstall', label: '卸载', danger: true },
                  ] },
                ],
                onClick: ({ key }) => {
                  const [core, action] = key.split('-') as ['singbox' | 'xray', api.LifecycleAction];
                  void handleLifecycle(record, core, action);
                },
              }}
            >
              <Button type="link" size="small" icon={<SettingOutlined />} loading={busy === `lifecycle:${record.id}`}>
                管理
              </Button>
            </Dropdown>
          )}
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setBatchServer(record);
              setBatchOpen(true);
            }}
          >
            一键加节点
          </Button>
          <Button
            type="link"
            size="small"
            icon={<SafetyCertificateOutlined />}
            onClick={() => {
              setCertServer(record);
              setCertOpen(true);
            }}
          >
            证书
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除服务器 ${record.name}?`}
            description="被节点或中转规则引用时后端将拒绝删除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          服务器
        </Typography.Title>
        <Flex gap={8}>
          <Button
            icon={<ThunderboltOutlined />}
            loading={deploying}
            onClick={handleDeployAll}
          >
            部署全部
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增服务器
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

      <Alert
        type="info"
        showIcon
        message="操作说明"
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><Typography.Text strong>测连通</Typography.Text>:测试面板到机器的 SSH 连接是否可用。</li>
            <li>
              <Typography.Text strong>部署</Typography.Text>:把面板里该机已建的节点配置下发到机器(sing-box / xray 可单独选)。机器上缺核心二进制时会<strong>自动先安装</strong>。改动节点后需要重新部署才会生效。
            </li>
            <li>
              <Typography.Text strong>管理</Typography.Text>:管理机器上的核心程序本身——<Typography.Text strong>安装</Typography.Text>用于裸机首次装核心或升级重装版本;<Typography.Text strong>重启</Typography.Text>重启核心服务;<Typography.Text strong>卸载</Typography.Text>清理二进制与服务(机器退役时用)。
            </li>
            <li><Typography.Text strong>部署全部</Typography.Text>:右上角按钮,并发逐机下发所有机器的节点配置,结果逐台展示。</li>
          </ul>
        }
      />

      <Table<Server>
        rowKey="id"
        columns={columns}
        dataSource={servers}
        loading={loading}
        pagination={false}
        locale={{
          emptyText: (
            <EmptyState
              description="还没有服务器。SSH 模式:填写凭据由面板直连;Agent 模式:机器心跳上报(预留)。"
              action={
                <Button type="primary" onClick={openCreate}>
                  录入服务器
                </Button>
              }
            />
          ),
        }}
      />

      <ServerFormModal
        servers={servers}
        open={createOpen}
        record={editing}
        onClose={closeModal}
        onSaved={() => {
          closeModal();
          reload();
        }}
      />

      <CertModal
        open={certOpen}
        server={certServer}
        onClose={() => setCertOpen(false)}
        onChanged={reload}
      />
      <BatchNodesModal
        open={batchOpen}
        server={batchServer}
        snis={snis}
        onClose={() => setBatchOpen(false)}
        onDone={reload}
      />
      <DeployResultModal
        open={deployResults !== null}
        results={deployResults ?? []}
        onClose={() => setDeployResults(null)}
      />
    </Flex>
  );
}
