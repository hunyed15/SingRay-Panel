import { useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Flex, Modal, Typography } from 'antd';
import * as api from '../services/api';
import type { Server } from '../services/types';

interface Props {
  open: boolean;
  server: Server | null;
  onClose: () => void;
  onChanged: () => void;
}

/** TLS 证书管理:查看域名证书状态,签发 ACME 真证书(Let's Encrypt)。 */
export function CertModal({ open, server, onClose, onChanged }: Props) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<api.CertStatusInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);

  const load = async () => {
    if (!server) return;
    setLoading(true);
    try {
      setStatus(await api.getCertStatus(server.id));
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && server) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.id]);

  const handleIssue = async () => {
    if (!server) return;
    setIssuing(true);
    try {
      const r = await api.issueCert(server.id);
      if (r.ok || r.steps) {
        message.success({ content: `证书签发成功(${(r.steps ?? []).join(' → ')})。请对该机器执行「部署」使 vmess/trojan 启用真证书。`, duration: 10 });
        await load();
        onChanged();
      } else {
        message.error({ content: `签发失败:${r.error ?? '未知原因'}(常见原因:域名未解析到本机 / 80 端口被占用或防火墙未放行)`, duration: 10 });
      }
    } catch {
      // api 层已提示
    } finally {
      setIssuing(false);
    }
  };

  return (
    <Modal
      title={`TLS 证书 — ${server?.name ?? ''}`}
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="issue" type="primary" loading={issuing} onClick={handleIssue}>
          签发 / 续期证书
        </Button>,
      ]}
      width={560}
    >
      <Flex vertical gap={12}>
        <Alert
          type="info"
          showIcon
          message="为什么需要真证书"
          description="新版 Xray 已移除 allowInsecure,自签证书的 vmess/trojan 在客户端无法跳过验证。签发 Let's Encrypt 真证书(HTTP-01,临时占用 80 端口)后部署即自动启用;acme.sh 定时任务自动续期并重载核心。"
        />
        {status && (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="域名">{status.domain}</Descriptions.Item>
            <Descriptions.Item label="acme.sh">
              {status.acmeInstalled ? '✅ 已安装' : '未安装(签发时自动安装)'}
            </Descriptions.Item>
            <Descriptions.Item label="证书">
              {status.certExists ? '✅ 已签发' : '未签发'}
            </Descriptions.Item>
            {status.expiresAt && (
              <Descriptions.Item label="到期时间">
                {new Date(status.expiresAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
            )}
            {!status.domain || /^\d+\.\d+\.\d+\.\d+$/.test(status.domain) || status.domain.includes(':') ? (
              <Descriptions.Item label="⚠️">
                <Typography.Text type="danger">
                  机器地址不是域名,无法签发 ACME 证书。请先在服务器编辑中把 client_host 设为解析到本机的域名。
                </Typography.Text>
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        )}
        {loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {status?.certExists && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            签发后需对该机器点「部署」,vmess-ws-tls / trojan-tls 将自动改用真证书(无需改节点)。
          </Typography.Text>
        )}
      </Flex>
    </Modal>
  );
}
