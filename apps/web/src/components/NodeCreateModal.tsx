import { useEffect, useState } from 'react';
import { Alert, App, Card, Flex, Form, Input, InputNumber, Modal, Segmented, Select, Typography, theme } from 'antd';
import * as api from '../services/api';
import type {
  NodeItem,
  NodeTemplate,
  OutboundType,
  Server,
  SniItem,
} from '../services/types';

interface NodeCreateModalProps {
  open: boolean;
  servers: Server[];
  landings: Server[];
  snis: SniItem[];
  onClose: () => void;
  onCreated: (node: NodeItem) => void;
}

interface FormValues {
  name: string;
  serverId: number;
  outboundType: OutboundType;
  landingServerId?: number;
  sni?: string;
  port?: number;
  tunnelAddress?: string;
  tunnelPort?: number;
  authUser?: string;
  authPassword?: string;
}

/** 11 种 SingBox 模板(与后端 TEMPLATE_META 一致) */
const TEMPLATES: { key: NodeTemplate; title: string; desc: string }[] = [
  { key: 'vless-reality', title: 'VLESS + Reality', desc: '主力 · 借站 SNI · 零证书' },
  { key: 'vmess-ws-tls', title: 'VMess + WS + TLS', desc: '兼容老客户端 · 自签证书' },
  { key: 'trojan-tls', title: 'Trojan + TLS', desc: '自签证书' },
  { key: 'ss2022', title: 'Shadowsocks-2022', desc: '极简 · 客户端覆盖广' },
  { key: 'hysteria', title: 'Hysteria2', desc: 'UDP 加速 · 弱网友好' },
  { key: 'socks', title: 'SOCKS', desc: '通用代理' },
  { key: 'http', title: 'HTTP', desc: '通用代理' },
  { key: 'tunnel', title: '隧道(端口转发)', desc: 'IPv4/IPv6 互通 · 固定目标转发' },
  { key: 'tuic', title: 'TUIC', desc: 'QUIC · 弱网友好 · 自签证书' },
  { key: 'shadowtls', title: 'ShadowTLS', desc: 'TLS 伪装借站 · 零证书' },
  { key: 'naive', title: 'Naive', desc: 'HTTP/2+TLS · 自签' },
];

const OUTBOUND_OPTIONS = [
  { label: '直连', value: 'direct' },
  { label: '中转', value: 'relay' },
];

/**
 * 节点新建(模板制):选模板卡片 → 填名称 → 选入口机 → 选出口。
 * 端口、凭据、Reality 密钥、自签证书全部由后端自动生成;创建后需「部署全部」下发。
 */
export function NodeCreateModal({ open, servers, landings, snis, onClose, onCreated }: NodeCreateModalProps) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [template, setTemplate] = useState<NodeTemplate>('vless-reality');
  const [creating, setCreating] = useState(false);
  const serverId = Form.useWatch('serverId', form);
  // 名称自动预填:<落地机名>-<模板名>-sb(手填过则不覆盖)
  useEffect(() => {
    if (!open || !serverId || form.isFieldTouched('name')) return;
    const s = servers.find((x) => x.id === serverId);
    if (s) form.setFieldsValue({ name: `${s.name}-${template}-sb` });
  }, [open, serverId, template, servers]);
  const outboundType = Form.useWatch('outboundType', form) ?? ('direct' as OutboundType);
  const ready = servers.length > 0;

  const serverOptions = servers.map((s) => ({
    value: s.id,
    label: `${s.name}(${s.role === 'relay' ? '中转机' : '落地机'})`,
  }));
  const landingOptions = landings.map((s) => ({ value: s.id, label: `${s.name} · ${s.client_host || s.host}` }));
  const sniOptions = snis.map((s) => ({
    value: s.domain,
    label: s.note ? `${s.domain} · ${s.note}` : s.domain,
  }));

  const handleOk = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const isTunnel = template === 'tunnel';
      const node = await api.createNode({
        template,
        name: values.name.trim(),
        serverId: Number(values.serverId),
        outboundType: isTunnel ? undefined : values.outboundType,
        landingServerId:
          !isTunnel && values.outboundType === 'relay' ? Number(values.landingServerId) : undefined,
        sni:
          !isTunnel && (template === 'vless-reality' || template === 'shadowtls')
            ? values.sni ?? (template === 'vless-reality' ? 'www.microsoft.com' : 'www.google.com')
            : undefined,
        port: values.port ? Number(values.port) : undefined,
        tunnelAddress: isTunnel ? values.tunnelAddress : undefined,
        tunnelPort: isTunnel && values.tunnelPort ? Number(values.tunnelPort) : undefined,
        authUser: template === 'socks' || template === 'http' ? values.authUser : undefined,
        authPassword: template === 'socks' || template === 'http' ? values.authPassword : undefined,
      });
      message.success(`节点 ${node.name} 已创建(端口 ${node.listen_port})`);
      onCreated(node);
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建节点"
      okText="创建"
      cancelText="取消"
      width={720}
      confirmLoading={creating}
      maskClosable={false}
      destroyOnHidden
      okButtonProps={{ disabled: !ready }}
      onOk={handleOk}
      onCancel={onClose}
    >
      {!ready && (
        <Alert
          type="warning"
          showIcon
          message="还没有服务器"
          description="请先在「服务器」页添加至少一台机器,再创建节点。"
          style={{ marginBottom: 16 }}
        />
      )}

      <Typography.Text strong>1 · 选择模板</Typography.Text>
      <Flex wrap gap={12} style={{ marginTop: 8, marginBottom: 20 }}>
        {TEMPLATES.map((t) => {
          const active = template === t.key;
          return (
            <Card
              key={t.key}
              size="small"
              hoverable
              onClick={() => setTemplate(t.key)}
              style={{
                width: 200,
                borderColor: active ? token.colorPrimary : undefined,
              }}
            >
              <Flex vertical gap={4}>
                <Typography.Text strong>{t.title}</Typography.Text>
                <Typography.Text type="secondary">{t.desc}</Typography.Text>
              </Flex>
            </Card>
          );
        })}
      </Flex>

      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={
          ready
            ? {
                serverId: servers[0].id,
                outboundType: 'direct' as OutboundType,
                sni: snis[0]?.domain ?? 'www.microsoft.com',
              }
            : undefined
        }
      >
        <Form.Item name="name" label="2 · 节点名称(自动生成:机器-模板-sb,可改)" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="如:HK1 主力 / 家用直连" />
        </Form.Item>
        <Form.Item
          name="serverId"
          label="3 · 入口机(节点监听在哪台机器)"
          rules={[{ required: true, message: '请选择入口机' }]}
        >
          <Select options={serverOptions} />
        </Form.Item>
        <Form.Item
          name="port"
          label="端口(可选,留空自动分配)"
          tooltip="自动分配保证同机不冲突;手动指定可对齐已有防火墙规则。"
        >
          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
        </Form.Item>
        {template === 'tunnel' ? (
          <>
            <Form.Item
              name="tunnelAddress"
              label="转发目标地址(IPv4 / IPv6 / 域名)"
              rules={[{ required: true, message: '请输入目标地址' }]}
            >
              <Input placeholder="2001:db8::1 或 1.2.3.4 或 example.com" />
            </Form.Item>
            <Form.Item
              name="tunnelPort"
              label="转发目标端口"
              rules={[{ required: true, message: '请输入目标端口' }]}
            >
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </>
        ) : (
          <Form.Item name="outboundType" label="4 · 出口">
            <Segmented options={OUTBOUND_OPTIONS} block />
          </Form.Item>
        )}
        {outboundType === 'relay' && template !== 'tunnel' && (
          <Form.Item
            name="landingServerId"
            label="5 · 中转落地机(客户端经入口机 → 该落地机出网)"
            rules={[{ required: true, message: '请选择落地机' }]}
          >
            <Select options={landingOptions} />
          </Form.Item>
        )}
        {(template === 'socks' || template === 'http') && (
          <>
            <Alert
              type="warning"
              showIcon
              message="开放代理易被扫描滥用"
              description="建议填写用户名与密码;留空 = 任何人都能使用该代理(公网端口会被扫描器利用)。"
              style={{ marginBottom: 16 }}
            />
            <Flex gap={16}>
              <Form.Item name="authUser" label="用户名" style={{ flex: 1 }}>
                <Input placeholder="如 sr-user" autoComplete="off" />
              </Form.Item>
              <Form.Item name="authPassword" label="密码" style={{ flex: 1 }}>
                <Input placeholder="设置密码" autoComplete="off" />
              </Form.Item>
            </Flex>
          </>
        )}
        {template === 'naive' && (
          <Alert
            type="warning"
            showIcon
            message="Naive 需要真实 TLS 证书才有抗封锁价值"
            description="面板将生成自签证书,客户端需开启「允许不安全连接」。"
            style={{ marginBottom: 16 }}
          />
        )}
        {(template === 'vless-reality' || template === 'shadowtls') && (
          <Form.Item
            name="sni"
            label={
              template === 'vless-reality'
                ? 'Reality 借站域名(SNI)'
                : 'ShadowTLS 握手借站域名(SNI)'
            }
            tooltip="域名库可在「设置」页或本页「Reality 域名库」中管理"
          >
            <Select options={sniOptions} showSearch />
          </Form.Item>
        )}
      </Form>
      <Typography.Text type="secondary">
        端口与凭据(UUID/密码/Reality 密钥/自签证书)自动生成;创建后需在「服务器」页执行「部署全部」下发配置。
      </Typography.Text>
    </Modal>
  );
}
