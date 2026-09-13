import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Flex, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import * as api from '../services/api';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState } from '../components/EmptyState';

interface CertRow {
  serverId: number;
  name: string;
  domain: string;
  acmeInstalled: boolean;
  certExists: boolean;
  expiresAt: string | null;
  reachable: boolean;
  error?: string;
}

/**
 * 证书管理页:全部 SSH 机器的域名证书状态一览(acme.sh / Let's Encrypt)。
 * vmess-ws-tls / trojan-tls 依赖真证书(新版 Xray 已移除 allowInsecure);
 * vless-reality / shadowsocks 不需要证书。
 */
export function CertificatesPage() {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsyncData(async () => api.getCerts());
  const [issuing, setIssuing] = useState<number | null>(null);
  const rows: CertRow[] = data ?? [];

  const handleIssue = useCallback(async (row: CertRow) => {
    setIssuing(row.serverId);
    try {
      const r = await api.issueCert(row.serverId);
      if (r.ok || r.steps) {
        message.success({ content: `${row.name} 证书签发成功(${(r.steps ?? []).join(' → ')})。部署后 vmess/trojan 自动启用。`, duration: 8 });
        await reload();
      } else {
        message.error({ content: `${row.name} 签发失败:${r.error ?? '未知原因'}`, duration: 10 });
      }
    } catch {
      // api 层已提示
    } finally {
      setIssuing(null);
    }
  }, [message, reload]);

  const columns: ColumnsType<CertRow> = [
    { title: '机器', dataIndex: 'name', width: 120, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: '域名',
      dataIndex: 'domain',
      width: 200,
      render: (v: string, r) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(v) || v.includes(':') ? (
          <Typography.Text type="warning">{v}(非域名,无法签发)</Typography.Text>
        ) : (
          <Typography.Text code>{v}</Typography.Text>
        ),
    },
    {
      title: '可达性',
      dataIndex: 'reachable',
      width: 90,
      render: (v: boolean, r) => (v ? <Typography.Text type="success">在线</Typography.Text> : <Typography.Text type="danger">不可达{r.error ? `(${r.error.slice(0, 40)})` : ''}</Typography.Text>),
    },
    { title: 'acme.sh', dataIndex: 'acmeInstalled', width: 90, render: (v: boolean) => (v ? '✅' : '—') },
    {
      title: '证书状态',
      key: 'cert',
      width: 130,
      render: (_, r) =>
        r.certExists ? (
          <Typography.Text type="success" strong>✅ 已签发</Typography.Text>
        ) : r.reachable ? (
          <Typography.Text type="secondary">未签发</Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '到期时间',
      dataIndex: 'expiresAt',
      width: 170,
      render: (v: string | null, r) => {
        if (!v) return '-';
        const days = Math.floor((new Date(v).getTime() - Date.now()) / 86400000);
        const color = days < 14 ? '#d4380d' : days < 30 ? '#d46b08' : undefined;
        return (
          <Typography.Text style={color ? { color } : undefined}>
            {new Date(v).toLocaleDateString('zh-CN')} ({days} 天)
          </Typography.Text>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          icon={<SafetyCertificateOutlined />}
          disabled={!r.reachable || !r.domain || /^\d+\.\d+\.\d+\.\d+$/.test(r.domain) || r.domain.includes(':')}
          loading={issuing === r.serverId}
          onClick={() => handleIssue(r)}
        >
          {r.certExists ? '续期' : '签发'}
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        证书管理
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        message="这些证书给谁用?"
        description="vmess-ws-tls / trojan-tls 需要真证书(新版 Xray 移除了 allowInsecure,自签证书客户端不再接受);vless-reality 和 shadowsocks 不需要证书。签发后需对机器执行「部署」生效;证书由 acme.sh 自动续期并重载核心。签发过程临时占用机器 80 端口(HTTP-01 验证),域名须解析到对应机器。"
      />
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
      <Table<CertRow>
        rowKey="serverId"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{
          emptyText: <EmptyState description="还没有 SSH 服务器。" />,
        }}
      />
    </Flex>
  );
}
