import { useEffect, useState } from 'react';
import { Alert, App, Card, Flex, Form, Input, InputNumber, Modal, Segmented, Select, Typography, theme } from 'antd';
import * as api from '../services/api';
import type {
  OutboundType,
  Server,
  SniItem,
  XrayNodeItem,
  XrayNodeTemplate,
} from '../services/types';

interface XrayNodeCreateModalProps {
  open: boolean;
  servers: Server[];
  landings: Server[];
  snis: SniItem[];
  onClose: () => void;
  onCreated: (node: XrayNodeItem) => void;
}

interface FormValues {
  name: string;
  serverId: number;
  outboundType: OutboundType;
  landingServerId?: number;
  sni?: string;
  flow?: string;
  port?: number;
}

/** 6 种 Xray 模板(与后端 XRAY_TEMPLATE_META 一致) */
const TEMPLATES: { key: XrayNodeTemplate; title: string; desc: string }[] = [
  { key: 'xray-vless-reality', title: 'VLESS + Reality', desc: 'XTLS · xtls-rprx-vision flow' },
  { key: 'xray-vmess-ws-tls', title: 'VMess + WS + TLS', desc: '自签证书' },
  { key: 'xray-trojan-tls', title: 'Trojan + TLS', desc: '自签证书' },
  { key: 'xray-ss', title: 'Shadowsocks AEAD', desc: 'aes-128-gcm 加密' },
  { key: 'xray-socks', title: 'SOCKS', desc: '通用代理' },
  { key: 'xray-http', title: 'HTTP', desc: '通用代理' },
];

const OUTBOUND_OPTIONS = [
  { label: '直连', value: 'direct' },
  { label: '中转', value: 'relay' },
];

export function XrayNodeCreateModal({
  open,
  servers,
  landings,
  snis,
  onClose,
  onCreated,
}: XrayNodeCreateModalProps) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [template, setTemplate] = useState<XrayNodeTemplate>('xray-vless-reality');
  const [creating, setCreating] = useState(false);
  const serverId = Form.useWatch('serverId', form);
  // 名称自动预填:<落地机名>-<模板名去前缀>-xray(手填过则不覆盖)
  useEffect(() => {
    if (!open || !serverId || form.isFieldTouched('name')) return;
    const s = servers.find((x) => x.id === serverId);
    if (s) form.setFieldsValue({ name: `${s.name}-${template.replace(/^xray-/, '')}-xray` });
  }, [open, serverId, template, servers]);
  const ready = servers.length > 0;
  const outboundType = Form.useWatch('outboundType', form) ?? ('direct' as OutboundType);

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
      const node = await api.createXrayNode({
        template,
        name: values.name.trim(),
        serverId: Number(values.serverId),
        outboundType: values.outboundType,
        landingServerId:
          values.outboundType === 'relay' ? Number(values.landingServerId) : undefined,
        sni:
          template === 'xray-vless-reality'
            ? values.sni ?? snis[0]?.domain ?? 'www.microsoft.com'
            : undefined,
        flow: template === 'xray-vless-reality' ? values.flow || 'xtls-rprx-vision' : undefined,
        port: values.port ? Number(values.port) : undefined,
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
      title="新建 Xray 节点"
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
                flow: 'xtls-rprx-vision',
                sni: snis[0]?.domain ?? 'www.microsoft.com',
              }
            : undefined
        }
      >
        <Form.Item name="name" label="2 · 节点名称(自动生成:机器-模板-xray,可改)" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="如:HK1 Xray 主力" />
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
        <Form.Item name="outboundType" label="4 · 出口">
          <Segmented options={OUTBOUND_OPTIONS} block />
        </Form.Item>
        {outboundType === 'relay' && (
          <Form.Item
            name="landingServerId"
            label="5 · 中转落地机(客户端经入口机 → 该落地机出网)"
            rules={[{ required: true, message: '请选择落地机' }]}
          >
            <Select options={landingOptions} />
          </Form.Item>
        )}
        {template === 'xray-vless-reality' && (
          <>
            <Form.Item
              name="sni"
              label="Reality 借站域名(SNI)"
              tooltip="域名库可在「设置」页管理"
            >
              <Select options={sniOptions} showSearch />
            </Form.Item>
            <Form.Item
              name="flow"
              label="Flow 控制"
              tooltip="xtls-rprx-vision 为推荐的 VLESS 流控"
            >
              <Input placeholder="xtls-rprx-vision" />
            </Form.Item>
          </>
        )}
      </Form>
      <Typography.Text type="secondary">
        端口与凭据(UUID/密码/Reality 密钥/自签证书)自动生成;创建后需在「服务器」页执行「部署全部」下发配置。
      </Typography.Text>
    </Modal>
  );
}
