import { useState } from 'react';
import { Alert, App, Button, Card, Col, Flex, Form, Input, Row, Select, Typography } from 'antd';
import { ApiOutlined, BellOutlined, CloudServerOutlined, LinkOutlined, CopyOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import * as api from '../services/api';
import { useAsyncData } from '../hooks/useAsyncData';
import { SniLibraryCard } from '../components/SniLibraryCard';
import { OpsCard } from '../components/OpsCard';

/**
 * 设置页(四块):
 *  1. 订阅(链接 + slug + Reality 地址模式)
 *  2. 证书签发(DNS-01 Cloudflare Token / HTTP-01)
 *  3. 告警(Telegram Bot)
 *  4. 运维(备份/健康检查/调度) + SNI 域名库
 */
export function SettingsPage() {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsyncData(api.getSettings);
  const { data: snis, reload: reloadSnis } = useAsyncData(api.getSnis);

  const [certForm] = Form.useForm<{ cfToken?: string }>();
  const [tgForm] = Form.useForm<{ tgBotToken?: string; tgChatId?: string }>();
  const [slugForm] = Form.useForm<{ subSlug: string }>();
  const [saving, setSaving] = useState<string | null>(null);

  const slug = data?.subSlug ?? '';
  const fullUrl = `${window.location.origin}${data?.subUrl ?? '/sub/'}`;
  const xrayFullUrl = `${window.location.origin}/sub/xray/${slug}`;
  const adaptiveUrl = fullUrl.replace('/sub/singbox/', '/sub/');

  const save = async (key: string, patch: Parameters<typeof api.updateSettings>[0], okMsg: string) => {
    setSaving(key);
    try {
      await api.updateSettings(patch);
      message.success(okMsg);
      reload();
    } catch {
      // api 层已提示
    } finally {
      setSaving(null);
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

  /** 订阅地址行(URL + 复制 + 预览) */
  const SubUrlRow = ({ url, previewUrl }: { url: string; previewUrl?: string }) => (
    <Flex gap={8} align="center">
      <Typography.Text code style={{ flex: 1, fontSize: 13 }}>
        {url}
      </Typography.Text>
      <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopy(url, '订阅链接')}>
        复制
      </Button>
      <Button size="small" icon={<LinkOutlined />} onClick={() => window.open(previewUrl ?? url, '_blank', 'noopener')}>
        预览
      </Button>
    </Flex>
  );

  if (loading) {
    return (
      <Flex justify="center" style={{ padding: '48px 0' }}>
        <Typography.Text type="secondary">加载中…</Typography.Text>
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

      {/* ---------- 1. 订阅 ---------- */}
      <Card title={<><CloudServerOutlined /> 订阅</>}>
        <Flex vertical gap={16}>
          <Alert
            type="info"
            showIcon
            message="一个 slug,三条订阅地址"
            description="内容 = 全部启用的节点 + 已开启「进订阅」的中转线路。节点增删/启停后,客户端重新拉取即生效。"
          />

          <div>
            <Typography.Text strong>自适应订阅</Typography.Text>
            <Typography.Text type="secondary"> — 推荐:按客户端 UA 自动分发给所有客户端</Typography.Text>
            <SubUrlRow url={adaptiveUrl} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              sing-box → JSON · Clash/mihomo → YAML · 其余(v2rayN 等)→ base64
            </Typography.Text>
          </div>

          <div>
            <Typography.Text strong>通用订阅</Typography.Text>
            <Typography.Text type="secondary"> — v2rayN / Clash Meta / Shadowrocket</Typography.Text>
            <SubUrlRow url={xrayFullUrl} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              base64 分享链接;自动排除客户端不可用的 socks/http 节点
            </Typography.Text>
          </div>

          <div>
            <Typography.Text strong>SingBox 订阅</Typography.Text>
            <Typography.Text type="secondary"> — SFI/SFA/SFM 等 sing-box 客户端(tun + 分流规则)</Typography.Text>
            <SubUrlRow url={fullUrl} previewUrl={`${fullUrl}?format=singbox`} />
          </div>

          <Row gutter={24}>
            <Col span={12}>
              <Typography.Text strong>Reality 节点地址模式</Typography.Text>
              <Flex vertical gap={4} style={{ marginTop: 4 }}>
                <Flex justify="space-between" align="center">
                  <Typography.Text>SingBox 订阅用 IP</Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 130 }}
                    value={data?.singboxRealityIp ? 'ip' : 'domain'}
                    onChange={(v) => save('sbIp', { singboxRealityIp: v === 'ip' }, v === 'ip' ? 'SingBox 订阅已用 IP' : 'SingBox 订阅已用域名')}
                    options={[
                      { value: 'ip', label: 'IP(推荐)' },
                      { value: 'domain', label: '域名' },
                    ]}
                  />
                </Flex>
                <Flex justify="space-between" align="center">
                  <Typography.Text>Xray 订阅用 IP</Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 130 }}
                    value={data?.xrayRealityIp ? 'ip' : 'domain'}
                    onChange={(v) => save('xrIp', { xrayRealityIp: v === 'ip' }, v === 'ip' ? 'Xray 订阅已用 IP' : 'Xray 订阅已用域名')}
                    options={[
                      { value: 'ip', label: 'IP(推荐)' },
                      { value: 'domain', label: '域名' },
                    ]}
                  />
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Reality 无需证书验证域名:用 IP 可绕开 DNS 解析(部分域名权威 DNS 响应慢会拖慢测速);vmess/trojan 因验证书始终用域名。
                </Typography.Text>
              </Flex>
            </Col>
            <Col span={12}>
              <Typography.Text strong>订阅标识(slug)</Typography.Text>
              <Form
                form={slugForm}
                layout="inline"
                requiredMark={false}
                initialValues={{ subSlug: slug }}
                onFinish={(v) => save('slug', { subSlug: v.subSlug.trim() }, '已更新订阅链接')}
                style={{ marginTop: 4 }}
              >
                <Form.Item
                  name="subSlug"
                  rules={[
                    { required: true, message: '请输入 slug' },
                    { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅允许字母/数字/下划线/连字符' },
                  ]}
                  style={{ marginBottom: 8 }}
                >
                  <Input style={{ width: 220 }} placeholder={slug} />
                </Form.Item>
                <Form.Item style={{ marginBottom: 8 }}>
                  <Button htmlType="submit" loading={saving === 'slug'}>
                    保存
                  </Button>
                </Form.Item>
              </Form>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                三条订阅共用;修改后旧链接立即失效。
              </Typography.Text>
            </Col>
          </Row>
        </Flex>
      </Card>

      {/* ---------- 2. 证书签发 ---------- */}
      <Card title={<><SafetyCertificateOutlined /> 证书签发</>}>
        <Flex vertical gap={12}>
          <Alert
            type={data?.cfTokenSet ? 'success' : 'warning'}
            showIcon
            message={
              data?.cfTokenSet
                ? `DNS-01 已启用(Cloudflare Token 来源: ${data.cfTokenSource === 'db' ? '设置页' : '环境变量'})`
                : '未配置 Cloudflare Token — 当前只能 HTTP-01 验证(需机器 80 端口可达)'
            }
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                配置 Token 后,证书签发改走 DNS-01:不依赖任何入站端口,适用于 NAT VPS、80 端口被服务商拦截的机器。
                Token 需 Cloudflare 权限:Zone → DNS → Edit(仅限你的域名所在 zone)。
              </Typography.Text>
            }
          />
          <Form
            form={certForm}
            layout="vertical"
            onFinish={(v) => save('cf', { cfToken: v.cfToken ?? '' }, 'Cloudflare Token 已保存')}
          >
            <Form.Item
              name="cfToken"
              label="Cloudflare API Token"
              tooltip="留空保存 = 清除已保存的 Token(回退到环境变量)"
              style={{ marginBottom: 8 }}
            >
              <Input.Password placeholder={data?.cfTokenSet ? '已配置(输入新值可覆盖,留空保存可清除)' : '粘贴 Token'} />
            </Form.Item>
            <Button htmlType="submit" type="primary" loading={saving === 'cf'}>
              保存
            </Button>
          </Form>
        </Flex>
      </Card>

      {/* ---------- 3. 告警 ---------- */}
      <Card title={<><BellOutlined /> 告警</>}>
        <Flex vertical gap={12}>
          <Alert
            type={data?.tgBotTokenSet && data?.tgChatId ? 'success' : 'warning'}
            showIcon
            message={
              data?.tgBotTokenSet && data?.tgChatId
                ? 'Telegram 告警已启用(机器离线/核心停止/证书临期会推送)'
                : 'Telegram 告警未配置(告警仅记录,不推送)'
            }
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                找 @BotFather 创建 Bot 拿 Token;Chat ID 可向 @userinfobot 发送消息获取。
              </Typography.Text>
            }
          />
          <Form
            form={tgForm}
            layout="vertical"
            initialValues={{ tgChatId: data?.tgChatId ?? '' }}
            onFinish={(v) => save('tg', { tgBotToken: v.tgBotToken ?? '', tgChatId: v.tgChatId ?? '' }, 'Telegram 配置已保存')}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="tgBotToken" label="Bot Token" tooltip="留空保存 = 清除已保存的值" style={{ marginBottom: 8 }}>
                  <Input.Password placeholder={data?.tgBotTokenSet ? '已配置(输入新值可覆盖)' : '123456:ABC-DEF...'} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="tgChatId" label="Chat ID" style={{ marginBottom: 8 }}>
                  <Input placeholder="如 123456789" />
                </Form.Item>
              </Col>
            </Row>
            <Flex gap={8}>
              <Button htmlType="submit" type="primary" loading={saving === 'tg'}>
                保存
              </Button>
              <Button
                onClick={async () => {
                  try {
                    const r = await api.testTelegram();
                    if (r.delivered) message.success('测试消息已发送,请查看 Telegram');
                    else message.warning('未配置 TG 或发送失败(检查 Token/Chat ID,或面板网络无法访问 api.telegram.org)');
                  } catch {
                    // api 层已提示
                  }
                }}
              >
                发送测试消息
              </Button>
            </Flex>
          </Form>
        </Flex>
      </Card>

      {/* ---------- 4. 运维 + SNI ---------- */}
      <OpsCard />
      <SniLibraryCard snis={snis ?? []} onChanged={reloadSnis} />

      <Card title={<><ApiOutlined /> 说明</>}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          服务端环境变量(部署时配置,设置页未覆盖时生效):PANEL_CF_TOKEN(DNS-01)、TG_BOT_TOKEN / TG_CHAT_ID(告警)、
          PANEL_backup_* 系列(备份策略)。设置页保存的值优先于环境变量。
        </Typography.Text>
      </Card>
    </Flex>
  );
}
