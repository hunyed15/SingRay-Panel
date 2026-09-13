import { useMemo, useState } from 'react';
import { Alert, App, Checkbox, Flex, Form, Modal, Select, Typography } from 'antd';
import * as api from '../services/api';
import type { Server, SniItem } from '../services/types';

/** 各核心的默认勾选模板(落地机标准矩阵) */
const DEFAULT_TEMPLATES: Record<'singbox' | 'xray', string[]> = {
  // 默认只勾选 Xray 核心也支持的协议(vless/vmess/trojan);ss2022/hy2/tuic 按需手动勾
  singbox: ['vless-reality', 'vmess-ws-tls', 'trojan-tls'],
  xray: ['xray-vless-reality', 'xray-vmess-ws-tls', 'xray-trojan-tls', 'xray-ss', 'xray-socks', 'xray-http'],
};

const SINGBOX_TEMPLATES: { key: string; label: string }[] = [
  { key: 'vless-reality', label: 'VLESS + Reality' },
  { key: 'vmess-ws-tls', label: 'VMess + WS + TLS' },
  { key: 'trojan-tls', label: 'Trojan + TLS' },
  { key: 'ss2022', label: 'Shadowsocks 2022' },
  { key: 'hysteria', label: 'Hysteria2' },
  { key: 'tuic', label: 'TUIC' },
  { key: 'shadowtls', label: 'ShadowTLS' },
  { key: 'naive', label: 'NaiveProxy' },
  { key: 'socks', label: 'SOCKS5' },
  { key: 'http', label: 'HTTP' },
];

const XRAY_TEMPLATES: { key: string; label: string }[] = [
  { key: 'xray-vless-reality', label: 'VLESS + Reality' },
  { key: 'xray-vmess-ws-tls', label: 'VMess + WS + TLS' },
  { key: 'xray-trojan-tls', label: 'Trojan + TLS' },
  { key: 'xray-ss', label: 'Shadowsocks AEAD' },
  { key: 'xray-socks', label: 'SOCKS5' },
  { key: 'xray-http', label: 'HTTP' },
];

interface Props {
  open: boolean;
  server: Server | null;
  snis: SniItem[];
  onClose: () => void;
  onDone: () => void;
}

/**
 * 一键添加模板节点:按机器勾选两核心模板,Reality 从域名库选 SNI。
 * 自动命名 <机器>-<模板>-sb|-xray,同模板已存在自动跳过。
 */
export function BatchNodesModal({ open, server, snis, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState<string[]>([...DEFAULT_TEMPLATES.singbox, ...DEFAULT_TEMPLATES.xray]);
  const [realitySni, setRealitySni] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<api.BatchNodesResult | null>(null);

  const sniOptions = useMemo(
    () =>
      snis.map((s) => ({
        value: s.domain,
        label: s.note ? `${s.domain} · ${s.note}` : s.domain,
      })),
    [snis],
  );
  const preferredSni = sniOptions.find((o) => o.value === 'dl.google.com')?.value ?? sniOptions[0]?.value;
  const effectiveSni = realitySni ?? preferredSni;

  const reset = () => {
    setSelected([...DEFAULT_TEMPLATES.singbox, ...DEFAULT_TEMPLATES.xray]);
    setRealitySni(undefined);
    setResult(null);
  };

  const handleCreate = async () => {
    if (!server) return;
    if (!selected.length) {
      message.warning('请至少勾选一个模板');
      return;
    }
    if (!effectiveSni) {
      message.warning('请选择 Reality 域名(SNI 库为空时请先在设置页添加)');
      return;
    }
    setCreating(true);
    try {
      const sb = await api.batchCreateNodes(server.id, { core: 'singbox', templates: selected.filter((t) => !t.startsWith('xray-')), realitySni: effectiveSni });
      const xr = await api.batchCreateNodes(server.id, { core: 'xray', templates: selected.filter((t) => t.startsWith('xray-')), realitySni: effectiveSni });
      const merged: api.BatchNodesResult = {
        created: [...sb.created, ...xr.created],
        skipped: [...sb.skipped, ...xr.skipped],
      };
      setResult(merged);
      message.success(`已创建 ${merged.created.length} 个节点(跳过 ${merged.skipped.length} 个)`);
      onDone();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setCreating(false);
    }
  };

  const toggle = (key: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...prev, key] : prev.filter((k) => k !== key)));

  const renderGroup = (title: string, items: { key: string; label: string }[]) => (
    <div key={title} style={{ marginBottom: 8 }}>
      <Typography.Text strong>{title}</Typography.Text>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', marginTop: 4 }}>
        {items.map((t) => (
          <Checkbox
            key={t.key}
            checked={selected.includes(t.key)}
            onChange={(e) => toggle(t.key, e.target.checked)}
          >
            {t.label}
          </Checkbox>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      title={`一键添加模板节点 — ${server?.name ?? ''}`}
      open={open}
      onCancel={() => {
        onClose();
        reset();
      }}
      onOk={handleCreate}
      okText="创建"
      confirmLoading={creating}
      width={560}
      okButtonProps={{ disabled: !!result }}
    >
      <Flex vertical gap={12}>
        <Alert
          type="info"
          showIcon
          message="自动命名 <机器名>-<模板名>-<sb|xray>,端口与凭据自动生成;机器上已存在的同款模板会跳过。创建后需「部署」下发。"
        />
        {renderGroup('sing-box', SINGBOX_TEMPLATES)}
        {renderGroup('xray', XRAY_TEMPLATES)}
        <Form layout="vertical" style={{ marginBottom: 0 }}>
          <Form.Item label="Reality SNI 域名(vless-reality 使用,来自 SNI 域名库)" style={{ marginBottom: 0 }}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择 Reality 可用域名"
              value={effectiveSni}
              onChange={setRealitySni}
              options={sniOptions}
            />
          </Form.Item>
        </Form>
        {result && (
          <Alert
            type="success"
            showIcon
            message={`创建 ${result.created.length} 个,跳过 ${result.skipped.length} 个`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.created.map((c) => (
                  <li key={c.name}>{c.name} :{c.port}</li>
                ))}
                {result.skipped.map((s) => (
                  <li key={s.template} style={{ color: '#d46b08' }}>
                    {s.template}: {s.reason}
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </Flex>
    </Modal>
  );
}
