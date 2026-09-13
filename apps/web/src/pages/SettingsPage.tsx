import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Flex, Form, Input, Spin, Typography,
  Switch
} from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import * as api from '../services/api';
import { useAsyncData } from '../hooks/useAsyncData';
import { SniLibraryCard } from '../components/SniLibraryCard';

interface SlugFormValues {
  subSlug: string;
}

/**
 * 设置页:订阅链接(双核订阅 + slug 自定义)、Reality 借站域名库管理、格式说明。
 */
export function SettingsPage() {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsyncData(api.getSettings);
  const { data: snis, reload: reloadSnis } = useAsyncData(api.getSnis);
  const [saving, setSaving] = useState(false);

  const slug = data?.subSlug ?? '';
  const [slugInput, setSlugInput] = useState('');

  useEffect(() => {
    setSlugInput(slug);
  }, [slug]);

  const fullUrl = `${window.location.origin}${data?.subUrl ?? '/sub/'}`;
  const xrayFullUrl = `${window.location.origin}/sub/xray/${slug}`;

  const handleSaveSlug = async (values: SlugFormValues) => {
    setSaving(true);
    try {
      await api.setSlug(values.subSlug.trim());
      message.success('已更新订阅链接');
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制${what}`);
    } catch {
      message.error('复制失败,请手动选择复制');
    }
  };

  if (loading) {
    return (
      <Flex justify="center" style={{ padding: '48px 0' }}>
        <Spin />
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        设置
      </Typography.Title>

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

      <Card title="订阅">
        <Flex vertical gap={16}>
          <Alert
            type="info"
            showIcon
            message="一个 slug,两条订阅链接"
            description="内容 = 全部「启用」节点(+勾选「进订阅」的中转线路)。节点增删/启停后,客户端重新拉取即生效。"
          />

          {/* 自适应订阅(推荐) */}
          <div>
            <Typography.Text strong>自适应订阅</Typography.Text>
            <Typography.Text type="secondary"> — 一个地址全客户端通用(v2rayN / sing-box / Clash·mihomo·Verge)</Typography.Text>
            <Flex gap={8} align="center" style={{ marginTop: 4 }}>
              <Typography.Text code style={{ flex: 1, fontSize: 13 }}>
                {fullUrl.replace('/sub/singbox/', '/sub/')}
              </Typography.Text>
              <Button icon={<CopyOutlined />} onClick={() => handleCopy(fullUrl.replace('/sub/singbox/', '/sub/'), '自适应订阅链接')}>
                复制
              </Button>
              <Button icon={<LinkOutlined />} onClick={() => window.open(fullUrl.replace('/sub/singbox/', '/sub/'), '_blank', 'noopener')}>
                预览
              </Button>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按客户端 UA 自动分发:sing-box → JSON;Clash/mihomo → YAML;其余 → base64 链接
            </Typography.Text>
          </div>

          {/* 通用订阅(Xray/v2rayN 等) */}
          <div>
            <Typography.Text strong>通用订阅</Typography.Text>
            <Typography.Text type="secondary"> — v2rayN / Clash Meta / Shadowrocket 等大多数客户端</Typography.Text>
            <Flex gap={8} align="center" style={{ marginTop: 4 }}>
              <Typography.Text code style={{ flex: 1, fontSize: 13 }}>
                {xrayFullUrl}
              </Typography.Text>
              <Button icon={<CopyOutlined />} onClick={() => handleCopy(xrayFullUrl, '通用订阅链接')}>
                复制
              </Button>
              <Button icon={<LinkOutlined />} onClick={() => window.open(xrayFullUrl, '_blank', 'noopener')}>
                预览
              </Button>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              base64 分享链接;自动排除客户端不可用的 socks/http/shadowtls/naive 节点
            </Typography.Text>
          </div>

          {/* SingBox 订阅 */}
          <div>
            <Typography.Text strong>SingBox 订阅</Typography.Text>
            <Typography.Text type="secondary"> — SFI/SFA/SFM 等 sing-box 客户端</Typography.Text>
            <Flex gap={8} align="center" style={{ marginTop: 4 }}>
              <Typography.Text code style={{ flex: 1, fontSize: 13 }}>
                {fullUrl}
              </Typography.Text>
              <Button icon={<CopyOutlined />} onClick={() => handleCopy(fullUrl, 'SingBox 订阅链接')}>
                复制
              </Button>
              <Button icon={<LinkOutlined />} onClick={() => window.open(`${fullUrl}?format=singbox`, '_blank', 'noopener')}>
                预览
              </Button>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              sing-box 客户端按 UA 自动拿完整 JSON 配置(含全部节点);`?format=singbox` 可强制
            </Typography.Text>
          </div>

          {/* Reality 地址模式开关 */}
          <div>
            <Typography.Text strong>Reality 节点地址</Typography.Text>
            <Typography.Text type="secondary"> — 按订阅独立生效,更新订阅后重测延迟</Typography.Text>
            <Flex vertical gap={6} style={{ marginTop: 4 }}>
              <Flex justify="space-between" align="center">
                <Typography.Text>SingBox 订阅:Reality 节点地址用 IP(绕开慢 DNS)</Typography.Text>
                <Switch
                  checked={data?.singboxRealityIp ?? true}
                  onChange={async (checked: boolean) => {
                    try {
                      await api.updateSettings({ singboxRealityIp: checked });
                      message.success(checked ? 'SingBox 订阅已切换为 IP 地址' : 'SingBox 订阅已切换为域名地址');
                      reload();
                    } catch {
                      // api 层已提示
                    }
                  }}
                />
              </Flex>
              <Flex justify="space-between" align="center">
                <Typography.Text>Xray 订阅:Reality 节点地址用 IP(绕开慢 DNS)</Typography.Text>
                <Switch
                  checked={data?.xrayRealityIp ?? true}
                  onChange={async (checked: boolean) => {
                    try {
                      await api.updateSettings({ xrayRealityIp: checked });
                      message.success(checked ? 'Xray 订阅已切换为 IP 地址' : 'Xray 订阅已切换为域名地址');
                      reload();
                    } catch {
                      // api 层已提示
                    }
                  }}
                />
              </Flex>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                说明:Reality 无需证书验证域名,用 IP 可绕开慢 DNS;vmess/trojan 因证书验证始终用域名。改动后客户端更新订阅生效。
              </Typography.Text>
            </Flex>
          </div>

          {/* slug 修改 */}
          <div>
            <Typography.Text strong>订阅标识(slug)</Typography.Text>
            <Typography.Text type="secondary"> — 两条链接共用,修改后旧链接立即失效</Typography.Text>
            <Form<SlugFormValues> layout="inline" requiredMark={false} onFinish={handleSaveSlug} style={{ marginTop: 4 }}>
              <Form.Item
                name="subSlug"
                initialValue={slugInput}
                rules={[
                  { required: true, message: '请输入 slug' },
                  { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅允许字母/数字/下划线/连字符' },
                ]}
                style={{ marginBottom: 8 }}
              >
                <Input style={{ width: 260 }} placeholder={slug} />
              </Form.Item>
              <Form.Item style={{ marginBottom: 8 }}>
                <Button type="primary" htmlType="submit" loading={saving}>
                  保存
                </Button>
              </Form.Item>
            </Form>
          </div>
        </Flex>
      </Card>

      <SniLibraryCard snis={snis ?? []} onChanged={reloadSnis} />

      <Card title="订阅格式说明">
        <Alert
          type="info"
          showIcon
          message="客户端按 User-Agent 自动匹配格式"
          description={
            <Flex vertical gap={4}>
              <Typography.Text>
                <b>SingBox 订阅</b>(/sub/&lt;slug&gt;): base64(v2rayN/Clash) + sing-box JSON(SFA/SFI),UA 自动判定。
              </Typography.Text>
              <Typography.Text>
                <b>Xray 订阅</b>(/sub/xray/&lt;slug&gt;): 仅 base64 格式,含 VLESS/VMess/Trojan/SS 分享链接。
              </Typography.Text>
              <Typography.Text type="secondary">
                订阅内容 = 当前所有「启用」状态的节点;新建或停用后,客户端重新拉取即生效。
              </Typography.Text>
            </Flex>
          }
        />
      </Card>
    </Flex>
  );
}
