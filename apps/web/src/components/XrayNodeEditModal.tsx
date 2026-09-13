import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Typography,
} from 'antd';
import * as api from '../services/api';
import type {
  OutboundType,
  Server,
  SniItem,
  XrayNodeItem,
  XrayNodeProtocol,
} from '../services/types';
import { XRAY_PROTOCOL_META } from '../utils/status';

interface XrayNodeEditModalProps {
  open: boolean;
  node: XrayNodeItem | null;
  landings: Server[];
  snis: SniItem[];
  onClose: () => void;
  onSaved: (node: XrayNodeItem) => void;
}

interface FormValues {
  protocol: XrayNodeProtocol;
  name: string;
  note: string;
  enabled: boolean;
  port: number;
  outboundType: OutboundType;
  landingServerId?: number;
  sni?: string;
  flow?: string;
  authUser?: string;
  authPassword?: string;
}

const PROTOCOL_OPTIONS = (Object.keys(XRAY_PROTOCOL_META) as XrayNodeProtocol[]).map((p) => ({
  value: p,
  label: XRAY_PROTOCOL_META[p].text,
}));

const OUTBOUND_OPTIONS = [
  { label: '直连', value: 'direct' },
  { label: '中转', value: 'relay' },
];

export function XrayNodeEditModal({
  open,
  node,
  landings,
  snis,
  onClose,
  onSaved,
}: XrayNodeEditModalProps) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const protocol = Form.useWatch('protocol', form) ?? node?.protocol;
  const outboundType = Form.useWatch('outboundType', form) ?? node?.outbound_type;

  const landingOptions = landings.map((s) => ({ value: s.id, label: `${s.name} · ${s.client_host || s.host}` }));
  const sniOptions = snis.map((s) => ({
    value: s.domain,
    label: s.note ? `${s.domain} · ${s.note}` : s.domain,
  }));

  useEffect(() => {
    if (!open || !node) return;
    form.resetFields();
    form.setFieldsValue({
      protocol: node.protocol,
      name: node.name,
      note: node.note,
      enabled: node.enabled === 1,
      port: node.listen_port,
      outboundType: node.outbound_type || 'direct',
      landingServerId: node.landing_server_id,
      sni: node.sni,
      flow: node.flow || 'xtls-rprx-vision',
      authUser: node.auth_user,
      authPassword: node.auth_password,
    });
  }, [open, node, form]);

  const handleOk = async () => {
    if (!node) return;
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateXrayNode(node.id, {
        name: values.name.trim(),
        note: values.note,
        enabled: values.enabled,
        port: Number(values.port),
        protocol: values.protocol,
        outboundType: values.outboundType,
        landingServerId:
          values.outboundType === 'relay' ? Number(values.landingServerId) : undefined,
        sni: values.protocol === 'vless' ? values.sni : undefined,
        flow:
          values.protocol === 'vless' ? values.flow || 'xtls-rprx-vision' : undefined,
        authUser:
          values.protocol === 'socks' || values.protocol === 'http' ? values.authUser : undefined,
        authPassword:
          values.protocol === 'socks' || values.protocol === 'http' ? values.authPassword : undefined,
      });
      message.success('已保存');
      onSaved(saved);
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`编辑 Xray 节点 — ${node?.name ?? ''}`}
      okText="保存"
      cancelText="取消"
      width={640}
      confirmLoading={saving}
      maskClosable={false}
      destroyOnHidden
      onOk={handleOk}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label="入口机">
          <Typography.Text>{node?.server_name}</Typography.Text>
        </Form.Item>
        <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
          <Select options={PROTOCOL_OPTIONS} />
        </Form.Item>
        {protocol && node && protocol !== node.protocol && (
          <Alert
            type="warning"
            showIcon
            message="协议已变更"
            description="保存后将重新生成凭据(UUID/密码),客户端需更新分享链接。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Flex gap={16}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
            style={{ flex: 1 }}
          >
            <Input />
          </Form.Item>
          <Form.Item name="note" label="备注" style={{ flex: 1 }}>
            <Input />
          </Form.Item>
        </Flex>
        <Flex gap={16}>
          <Form.Item
            name="port"
            label="端口"
            rules={[{ required: true, message: '请输入端口' }]}
            style={{ flex: 1 }}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ flex: 1 }}>
            <Switch />
          </Form.Item>
        </Flex>
        <Form.Item name="outboundType" label="出口">
          <Segmented options={OUTBOUND_OPTIONS} block />
        </Form.Item>
        {outboundType === 'relay' && (
          <Form.Item
            name="landingServerId"
            label="中转落地机(客户端经入口机 → 该落地机出网)"
            rules={[{ required: true, message: '请选择落地机' }]}
          >
            <Select options={landingOptions} />
          </Form.Item>
        )}
        {protocol === 'vless' && (
          <>
            <Form.Item name="sni" label="Reality 借站域名(SNI)">
              <Select options={sniOptions} showSearch />
            </Form.Item>
            <Form.Item name="flow" label="Flow 控制" tooltip="xtls-rprx-vision 为推荐的 VLESS 流控">
              <Input placeholder="xtls-rprx-vision" />
            </Form.Item>
          </>
        )}
        {(protocol === 'socks' || protocol === 'http') && (
          <Flex gap={16}>
            <Form.Item
              name="authUser"
              label="认证用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
              style={{ flex: 1 }}
            >
              <Input placeholder="用户名(留空则沿用已生成的)" />
            </Form.Item>
            <Form.Item
              name="authPassword"
              label="认证密码"
              style={{ flex: 1 }}
            >
              <Input placeholder="留空则沿用已生成的密码" />
            </Form.Item>
          </Flex>
        )}
      </Form>
    </Modal>
  );
}
