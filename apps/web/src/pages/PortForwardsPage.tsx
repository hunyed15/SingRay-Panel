import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Steps,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { ForwardMechanism, NodeItem, PortForwardItem, Server, XrayNodeItem } from '../services/types';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState } from '../components/EmptyState';
import { MECHANISM_META } from '../utils/status';

interface WizardValues {
  name: string;
  entryServerId: number;
  landingServerId: number;
  targetNodeId: string;
  entryPort?: number;
  targetPort: number;
  mechanism: ForwardMechanism;
}

const STEPS = [
  { title: '入口机' },
  { title: '落地机' },
  { title: '目标节点' },
  { title: '端口' },
  { title: '机制' },
];

const STEP_FIELDS: (keyof WizardValues)[][] = [
  ['entryServerId'],
  ['landingServerId'],
  ['targetNodeId'],
  ['targetPort'],
  ['mechanism'],
];

/**
 * 中转规则(端口转发):入口机端口 → 落地机节点端口。
 * 新建向导:选入口机 → 落地机 → 目标节点 → 端口 → 转发机制
 * (iptables DNAT 优先;socat 仅在 iptables 不可用时选择)。「进订阅」开关把该线路
 * 以「入口机地址+入口端口+落地节点参数」的形式并入 /sub 订阅。
 */
export function PortForwardsPage() {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [forwards, servers, nodes, xrayNodes] = await Promise.all([
      api.getPortForwards(),
      api.getServers(),
      api.getNodes(),
      api.getXrayNodes(),
    ]);
    return { forwards, servers, nodes, xrayNodes };
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(0);
  const [preflight, setPreflight] = useState<api.ForwardPreflight | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileServerId, setReconcileServerId] = useState<number | undefined>();
  const [reconcileReport, setReconcileReport] = useState<api.ForwardReconcileReport | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [form] = Form.useForm<WizardValues>();

  const forwards = data?.forwards ?? [];
  const servers: Server[] = data?.servers ?? [];
  const nodes: NodeItem[] = data?.nodes ?? [];
  const xrayNodes: XrayNodeItem[] = data?.xrayNodes ?? [];

  const relayServers = servers.filter((s) => s.role === 'relay');
  const landingServers = servers.filter((s) => s.role === 'landing');

  const serverOptions = (list: Server[]) =>
    list.map((s) => ({ value: s.id, label: `${s.name}(${s.client_host || s.host})` }));

  const landingServerId = Form.useWatch('landingServerId', form);
  const mechanism = Form.useWatch('mechanism', form) ?? 'iptables';
  // 目标节点限定为所选落地机上的节点
  const landingNodes = [
    ...nodes
      .filter((n) => n.server_id === landingServerId && n.protocol !== 'tunnel')
      .map((n) => ({ value: `singbox:${n.id}`, label: `[SingBox] ${n.name} port=${n.listen_port}` })),
    ...xrayNodes
      .filter((n) => n.server_id === landingServerId)
      .map((n) => ({ value: `xray:${n.id}`, label: `[Xray] ${n.name} port=${n.listen_port}` })),
  ];

  const openCreate = () => {
    form.resetFields();
    setStep(0);
    setCreateOpen(true);
  };

  const handleNext = async () => {
    try {
      await form.validateFields(STEP_FIELDS[step] as never);
    } catch {
      return;
    }
    // 选完目标节点(离开步骤 2)且名称未手填 → 按「入口机→目标节点」自动生成
    if (step === 2 && !form.isFieldTouched('name')) {
      const entry = servers.find((s) => s.id === form.getFieldValue('entryServerId'));
      const tv = form.getFieldValue('targetNodeId') as string | undefined;
      const [type, nid] = (tv ?? ':').split(':');
      const node = (type === 'singbox' ? nodes : xrayNodes).find((n) => n.id === Number(nid));
      if (entry && node) form.setFieldsValue({ name: `${entry.name}→${node.name}` });
    }
    // 进入「机制」步骤前预检入口机,探测结果驱动 iptables/socat 的显式选择
    if (step === 3) {
      const entryId = form.getFieldValue('entryServerId') as number;
      const entryPort = form.getFieldValue('entryPort') as number | undefined;
      setPreflighting(true);
      try {
        const pf = await api.preflightPortForward(entryId, entryPort);
        setPreflight(pf);
        if (!pf.iptablesAvailable) {
          form.setFieldValue('mechanism', 'socat');
          message.warning('入口机 iptables 不可用,已自动切换为 socat 模式');
        }
      } catch {
        setPreflight(null); // 预检失败不阻断创建,由创建时的明确报错兜底
      } finally {
        setPreflighting(false);
      }
    }
    setStep((s) => s + 1);
  };

  const handleReconcile = async () => {
    if (!reconcileServerId) return;
    setReconciling(true);
    try {
      setReconcileReport(await api.reconcilePortForwards(reconcileServerId));
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setReconciling(false);
    }
  };

  const handleCreate = async () => {
    let vals: WizardValues;
    try {
      vals = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const [type, nid] = vals.targetNodeId.split(':');
      await api.createPortForward({
        name: vals.name.trim(),
        entryServerId: vals.entryServerId,
        landingServerId: vals.landingServerId,
        targetNodeType: type as 'singbox' | 'xray',
        targetNodeId: Number(nid),
        entryPort: vals.entryPort ? Number(vals.entryPort) : undefined,
        targetPort: Number(vals.targetPort),
        mechanism: vals.mechanism,
      });
      message.success('中转规则已创建(需「部署全部」下发)');
      setCreateOpen(false);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (pf: PortForwardItem) => {
    try {
      await api.deletePortForward(pf.id);
      message.success('已删除中转规则');
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    }
  };

  const columns: ColumnsType<PortForwardItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 170,
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '入口机', dataIndex: 'entry_server_name', width: 100 },
    {
      title: '入口端口',
      dataIndex: 'entry_port',
      width: 90,
      render: (v: number) => <Typography.Text code>{v}</Typography.Text>,
    },
    { title: '落地机', dataIndex: 'landing_server_name', width: 100 },
    { title: '目标节点', dataIndex: 'target_node_name', width: 190 },
    {
      title: '目标端口',
      key: 'target_port',
      width: 90,
      render: (_, r) => <Typography.Text code>{r.target_port}</Typography.Text>,
    },
    {
      title: '机制',
      dataIndex: 'mechanism',
      width: 90,
      render: (m: ForwardMechanism) =>
        m ? (
          <Tag color={MECHANISM_META[m]?.tagColor ?? 'default'}>{MECHANISM_META[m]?.text ?? m}</Tag>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '进订阅',
      key: 'include_in_sub',
      width: 90,
      render: (_, r) => (
        <Switch
          size="small"
          checked={r.include_in_sub === 1}
          onChange={async (checked) => {
            try {
              await api.updatePortForward(r.id, { includeInSub: checked });
              message.success(checked ? '已加入订阅(以入口机地址+入口端口下发)' : '已移出订阅');
              reload();
            } catch {
              // 错误提示由 api 层统一弹出
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, r) => (
        <Popconfirm
          title={`删除转发规则 ${r.name}?`}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => handleDelete(r)}
        >
          <Button type="link" size="small" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          中转规则
        </Typography.Title>
        <Flex gap={8}>
          <Button icon={<SyncOutlined />} onClick={() => { setReconcileReport(null); setReconcileOpen(true); }}>
            对账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建中转
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

      <Table<PortForwardItem>
        rowKey="id"
        columns={columns}
        dataSource={forwards}
        loading={loading}
        pagination={false}
        locale={{
          emptyText: (
            <EmptyState
              description="还没有中转规则。iptables DNAT 转发,入口机零负担。"
              action={
                <Button type="primary" onClick={openCreate}>
                  新建中转
                </Button>
              }
            />
          ),
        }}
      />

      <Modal
        open={createOpen}
        title="新建中转规则"
        width={640}
        maskClosable={false}
        destroyOnHidden
        onCancel={() => setCreateOpen(false)}
        footer={
          <Flex justify="space-between">
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Flex gap={8}>
              {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>上一步</Button>}
              {step < STEPS.length - 1 && (
                <Button type="primary" onClick={handleNext}>
                  下一步
                </Button>
              )}
              {step === STEPS.length - 1 && (
                <Button type="primary" loading={creating} onClick={handleCreate}>
                  创建
                </Button>
              )}
            </Flex>
          </Flex>
        }
      >
        <Steps size="small" current={step} items={STEPS} style={{ marginBottom: 24 }} />
        <Form form={form} layout="vertical" requiredMark={false} initialValues={{ mechanism: 'socat' }}>
          {/* 步骤 0:名称 + 入口机 */}
          <div style={{ display: step === 0 ? undefined : 'none' }}>
            <Form.Item
              name="name"
              label="规则名称(留空则按「入口机→目标节点」自动生成)"
              rules={[{ required: true, message: '请输入名称' }]}
            >
              <Input placeholder="自动:CoreNet→Dedirock-vless-xray" />
            </Form.Item>
            <Form.Item
              name="entryServerId"
              label="入口机(对外暴露端口的机器)"
              rules={[{ required: true, message: '请选择入口机' }]}
              extra="通常为角色是「中转机」的机器"
            >
              <Select
                options={serverOptions(relayServers.length ? relayServers : servers)}
                placeholder="选择入口机"
                showSearch
                optionFilterProp="label"
              />
            </Form.Item>
          </div>

          {/* 步骤 1:落地机 */}
          <div style={{ display: step === 1 ? undefined : 'none' }}>
            <Form.Item
              name="landingServerId"
              label="落地机(目标节点所在机器)"
              rules={[{ required: true, message: '请选择落地机' }]}
            >
              <Select
                options={serverOptions(landingServers)}
                placeholder="选择落地机"
                showSearch
                optionFilterProp="label"
                onChange={() => form.setFieldValue('targetNodeId', undefined)}
              />
            </Form.Item>
          </div>

          {/* 步骤 2:目标节点 */}
          <div style={{ display: step === 2 ? undefined : 'none' }}>
            <Form.Item
              name="targetNodeId"
              label="目标节点(该落地机上的节点)"
              rules={[{ required: true, message: '请选择目标节点' }]}
            >
              {landingNodes.length ? (
                <Select
                  options={landingNodes}
                  placeholder="选择目标节点"
                  showSearch
                  optionFilterProp="label"
                  onChange={(_, option) => {
                    const label = Array.isArray(option) ? '' : String(option?.label ?? '');
                    const m = label.match(/port=(\d+)/);
                    if (m) form.setFieldValue('targetPort', Number(m[1]));
                  }}
                />
              ) : (
                <Select
                  disabled
                  placeholder={landingServerId ? '该落地机上暂无节点' : '请先在上一步选择落地机'}
                />
              )}
            </Form.Item>
          </div>

          {/* 步骤 3:端口 */}
          <div style={{ display: step === 3 ? undefined : 'none' }}>
            <Flex gap={16}>
              <Form.Item
                name="entryPort"
                label="入口端口(留空自动分配)"
                style={{ flex: 1 }}
              >
                <InputNumber min={20000} max={65000} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="targetPort"
                label="目标节点端口"
                rules={[{ required: true, message: '请输入目标端口' }]}
                style={{ flex: 1 }}
              >
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </Flex>
            <Typography.Text type="secondary">
              客户端连接「入口机:入口端口」,流量被转发到「落地机:目标节点端口」。
            </Typography.Text>
          </div>

          {/* 步骤 4:机制 */}
          <div style={{ display: step === 4 ? undefined : 'none' }}>
            <Form.Item name="mechanism" label="转发机制" rules={[{ required: true }]}>
              <Radio.Group
                options={[
                  { value: 'socat', label: 'socat 用户态转发(推荐,容器环境通用)' },
                  { value: 'iptables', label: 'iptables DNAT(仅独立内核机器)' },
                  { value: 'socat', label: 'socat 用户态转发' },
                ]}
              />
            </Form.Item>
            {preflight ? (
              <Alert
                type={mechanism === 'socat' ? 'warning' : preflight.iptablesAvailable ? 'success' : 'error'}
                showIcon
                style={{ marginBottom: 12 }}
                message={
                  preflight.iptablesAvailable
                    ? '预检通过:入口机 iptables 可用'
                    : '预检异常:入口机 iptables 不可用'
                }
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>iptables: {preflight.iptablesAvailable ? '✅ 可用' : '❌ 不可用'}</li>
                    <li>net.ipv4.ip_forward: {preflight.ipForward === '1' ? '✅ 已开启' : preflight.ipForward === '0' ? '⚠️ 未开启(创建时自动开启)' : '未知'}</li>
                    <li>socat: {preflight.socatAvailable ? '✅ 已安装' : '⚠️ 未安装(socat 模式需先安装)'}</li>
                    <li>入口端口: {preflight.entryPortBusy ? '❌ 已被占用' : '✅ 空闲'}</li>
                    {preflight.issues.map((i) => (
                      <li key={i} style={{ color: '#d4380d' }}>{i}</li>
                    ))}
                  </ul>
                }
              />
            ) : (
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                未获取预检结果(预检失败或跳过),请自行确认入口机环境。
              </Typography.Text>
            )}
            <Alert
              type={mechanism === 'socat' ? 'warning' : 'info'}
              showIcon
              message={
                mechanism === 'socat'
                  ? 'socat 常驻进程转发,占用入口机 CPU 与内存'
                  : 'iptables DNAT 内核态转发,入口机零负担'
              }
              description="仅在 iptables 不可用时(如容器无 NET_ADMIN 权限、内核未加载 NAT 模块)才选择 socat。"
            />
          </div>
        </Form>
      </Modal>

      {/* 对账:入口机实际规则 vs 数据库 */}
      <Modal
        title="规则对账"
        open={reconcileOpen}
        onCancel={() => setReconcileOpen(false)}
        footer={null}
        width={640}
      >
        <Flex vertical gap={12}>
          <Flex gap={8}>
            <Select
              style={{ flex: 1 }}
              placeholder="选择入口机"
              value={reconcileServerId}
              onChange={setReconcileServerId}
              options={serverOptions(servers)}
            />
            <Button type="primary" loading={reconciling} disabled={!reconcileServerId} onClick={handleReconcile}>
              对账
            </Button>
          </Flex>
          {reconcileReport && (
            <Alert
              type={
                reconcileReport.missingIptables.length ||
                reconcileReport.missingSocat.length ||
                reconcileReport.orphanIptables.length ||
                reconcileReport.orphanSocat.length
                  ? 'warning'
                  : 'success'
              }
              showIcon
              message={
                reconcileReport.missingIptables.length +
                  reconcileReport.missingSocat.length +
                  reconcileReport.orphanIptables.length +
                  reconcileReport.orphanSocat.length ===
                0
                  ? '✅ 机器规则与数据库一致'
                  : '发现差异(机器侧以 DB 为准修复)'
              }
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {reconcileReport.missingIptables.length > 0 && (
                    <li>DB 有但机器缺失的 iptables 规则 id: {reconcileReport.missingIptables.join(', ')}</li>
                  )}
                  {reconcileReport.missingSocat.length > 0 && (
                    <li>DB 有但机器缺失的 socat 端口: {reconcileReport.missingSocat.join(', ')}</li>
                  )}
                  {reconcileReport.orphanIptables.length > 0 && (
                    <li>机器上存在但 DB 未登记的规则: <Typography.Text code>{reconcileReport.orphanIptables.join(' | ')}</Typography.Text></li>
                  )}
                  {reconcileReport.orphanSocat.length > 0 && (
                    <li>机器上存在但 DB 未登记的 socat unit: {reconcileReport.orphanSocat.join(', ')}</li>
                  )}
                </ul>
              }
            />
          )}
        </Flex>
      </Modal>
    </Flex>
  );
}
