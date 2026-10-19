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
  Segmented,
  Select,
  Steps,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, NodeIndexOutlined, PlusOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as api from '../services/api';
import type { ForwardBatchInput, ForwardBatchItem, ForwardBatchPlan, ForwardMechanism, NodeItem, PortForwardItem, Server, XrayNodeItem } from '../services/types';
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

interface BatchValues {
  entryServerIds: number[];
  targetKeys: string[];
  /** 留空 = 跟随各入口机自己的机制设置 */
  mechanism?: ForwardMechanism;
  includeInSub: boolean;
}

/** 不进订阅、中转无意义的协议(与后端排除口径一致) */
const NOT_RELAYABLE = new Set(['socks', 'http', 'tunnel']);

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
  const [topologyOpen, setTopologyOpen] = useState(false);
  const [topology, setTopology] = useState<api.TopologyPreview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcileServerId, setReconcileServerId] = useState<number | undefined>();
  const [reconcileReport, setReconcileReport] = useState<api.ForwardReconcileReport | null>(null);
  const [reconciling, setReconciling] = useState(false);
  /** 按核心筛选:all / singbox / xray */
  const [coreFilter, setCoreFilter] = useState<'all' | 'singbox' | 'xray'>('all');
  /** 一键添加(入口机多选 × 落地节点多选) */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchPlan, setBatchPlan] = useState<ForwardBatchPlan | null>(null);
  const [batchBusy, setBatchBusy] = useState<'preview' | 'create' | null>(null);
  const [form] = Form.useForm<WizardValues>();
  const [batchForm] = Form.useForm<BatchValues>();

  const forwards = data?.forwards ?? [];
  const servers: Server[] = data?.servers ?? [];
  const nodes: NodeItem[] = data?.nodes ?? [];
  const xrayNodes: XrayNodeItem[] = data?.xrayNodes ?? [];

  /** 核心筛选后的规则(中间跳按所属链路的核心归并,不会孤立) */
  const visibleForwards = coreFilter === 'all' ? forwards : forwards.filter((f) => f.core === coreFilter);

  const relayServers = servers.filter((s) => s.role === 'relay');
  const landingServers = servers.filter((s) => s.role === 'landing');

  const serverOptions = (list: Server[]) =>
    list.map((s) => ({ value: s.id, label: `${s.name}(${s.client_host || s.host})` }));

  const landingServerId = Form.useWatch('landingServerId', form);
  const mechanism = Form.useWatch('mechanism', form) ?? 'iptables';
  const entryServerId = Form.useWatch('entryServerId', form);
  /** 入口机的可用端口白名单(NAT 机器);无则空串 */
  const entryPortAllow = servers.find((s) => s.id === entryServerId)?.port_allow ?? '';
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

  const openTopology = async () => {
    try {
      setTopology(await api.getTopology());
      setTopologyOpen(true);
    } catch {
      // api 层已提示
    }
  };

  const handleSyncTopology = async () => {
    setSyncing(true);
    try {
      const r = await api.syncTopology();
      message.success(`拓扑同步完成:新增 ${r.applied}/${r.created} 条,删除 ${r.deleted} 条${r.errors.length ? `,失败 ${r.errors.length} 条` : ''}`);
      setTopology(await api.getTopology());
      reload();
    } catch {
      // api 层已提示
    } finally {
      setSyncing(false);
    }
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

  // ---------- 一键添加 ----------

  /** 可选落地节点(排除不进订阅、中转无意义的协议) */
  const targetOptions = [
    ...nodes
      .filter((n) => !NOT_RELAYABLE.has(n.protocol))
      .map((n) => ({ value: `singbox:${n.id}`, label: `[SingBox] ${n.name} · ${n.server_name} :${n.listen_port}` })),
    ...xrayNodes
      .filter((n) => !NOT_RELAYABLE.has(n.protocol))
      .map((n) => ({ value: `xray:${n.id}`, label: `[Xray] ${n.name} · ${n.server_name} :${n.listen_port}` })),
  ];

  const openBatch = () => {
    setBatchPlan(null);
    setBatchOpen(true);
  };

  const toBatchInput = (vals: BatchValues): ForwardBatchInput => ({
    entryServerIds: vals.entryServerIds ?? [],
    targets: (vals.targetKeys ?? []).map((k) => {
      const [type, id] = k.split(':');
      return { type: type as 'singbox' | 'xray', id: Number(id) };
    }),
    mechanism: vals.mechanism || undefined,
    includeInSub: vals.includeInSub,
  });

  /** 预览端口分配(不落库):让用户在写机器之前看到每条规则会用什么端口 */
  const handleBatchPreview = async () => {
    let vals: BatchValues;
    try {
      vals = await batchForm.validateFields();
    } catch {
      return;
    }
    setBatchBusy('preview');
    try {
      setBatchPlan(await api.previewBatchPortForwards(toBatchInput(vals)));
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBatchBusy(null);
    }
  };

  const handleBatchCreate = async () => {
    let vals: BatchValues;
    try {
      vals = await batchForm.validateFields();
    } catch {
      return;
    }
    setBatchBusy('create');
    try {
      const r = await api.createBatchPortForwards(toBatchInput(vals));
      const failed = r.errors.length ? `,失败 ${r.errors.length} 条(${r.errors[0].name}:${r.errors[0].message})` : '';
      message.success(`一键添加完成:创建 ${r.created.length} 条,跳过 ${r.skipped.length} 条${failed}`);
      setBatchOpen(false);
      setBatchPlan(null);
      reload();
    } catch {
      // 错误提示由 api 层统一弹出
    } finally {
      setBatchBusy(null);
    }
  };

  /** 一键添加预览表格 */
  const batchColumns: ColumnsType<ForwardBatchItem> = [
    { title: '入口机', dataIndex: 'entryServerName', width: 110 },
    {
      title: '入口端口',
      dataIndex: 'entryPort',
      width: 90,
      render: (v: number | null) => (v ? <Typography.Text code>{v}</Typography.Text> : '-'),
    },
    { title: '→ 落地机', dataIndex: 'landingServerName', width: 110 },
    { title: '目标节点', dataIndex: 'targetNodeName', width: 180, ellipsis: true },
    {
      title: '机制',
      dataIndex: 'mechanism',
      width: 80,
      render: (m: ForwardMechanism) => <Tag color={MECHANISM_META[m]?.tagColor ?? 'default'}>{MECHANISM_META[m]?.text ?? m}</Tag>,
    },
    {
      title: '状态',
      key: 'action',
      render: (_, r) =>
        r.action === 'create' ? (
          <Tag color="green">新建</Tag>
        ) : (
          <Flex gap={4} align="center">
            <Tag>跳过</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.reason}
            </Typography.Text>
          </Flex>
        ),
    },
  ];

  const columns: ColumnsType<PortForwardItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 210,
      render: (v: string, r) => (
        <Flex gap={4} align="center">
          <Typography.Text strong>{v}</Typography.Text>
          {r.auto === 1 && <Tag color="blue">自动</Tag>}
        </Flex>
      ),
    },
    { title: '入口机', dataIndex: 'entry_server_name', width: 100 },
    {
      title: '核心',
      dataIndex: 'core',
      width: 80,
      render: (c: PortForwardItem['core']) =>
        c ? (
          <Tag color={c === 'singbox' ? 'geekblue' : 'purple'}>{c === 'singbox' ? 'SingBox' : 'Xray'}</Tag>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
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
        <Flex gap={8} align="center">
          <Segmented
            value={coreFilter}
            onChange={(v) => setCoreFilter(v as 'all' | 'singbox' | 'xray')}
            options={[
              { value: 'all', label: `全部(${forwards.length})` },
              { value: 'singbox', label: `SingBox(${forwards.filter((f) => f.core === 'singbox').length})` },
              { value: 'xray', label: `Xray(${forwards.filter((f) => f.core === 'xray').length})` },
            ]}
          />
          <Button icon={<NodeIndexOutlined />} onClick={openTopology}>
            拓扑
          </Button>
          <Button icon={<SyncOutlined />} onClick={() => { setReconcileReport(null); setReconcileOpen(true); }}>
            对账
          </Button>
          <Button icon={<ThunderboltOutlined />} onClick={openBatch}>
            一键添加
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
        dataSource={visibleForwards}
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
                label="入口端口(留空则按白名单自动分配)"
                style={{ flex: 1 }}
              >
                {/* 不锁 20000-65000:NAT 机器的可用端口段可能落在任意区间 */}
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
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
            {entryPortAllow && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                message={`该入口机的可用端口:${entryPortAllow}`}
                description="手填的入口端口必须在白名单内;留空则自动从白名单分配(NAT 机器只有这些端口能对外)。"
              />
            )}
          </div>

          {/* 步骤 4:机制 */}
          <div style={{ display: step === 4 ? undefined : 'none' }}>
            <Form.Item name="mechanism" label="转发机制" rules={[{ required: true }]}>
              <Radio.Group
                options={[
                  { value: 'socat', label: 'socat 用户态转发(推荐,容器环境通用)' },
                  { value: 'iptables', label: 'iptables DNAT(仅独立内核机器)' },
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

      {/* 一键添加:入口机(多选)× 落地节点(多选)→ 预览端口 → 批量创建 */}
      <Modal
        title="一键添加中转规则"
        open={batchOpen}
        width={880}
        maskClosable={false}
        destroyOnHidden
        onCancel={() => setBatchOpen(false)}
        footer={
          <Flex justify="space-between">
            <Button onClick={() => setBatchOpen(false)}>取消</Button>
            <Flex gap={8}>
              <Button loading={batchBusy === 'preview'} onClick={handleBatchPreview}>
                预览端口分配
              </Button>
              <Button
                type="primary"
                loading={batchBusy === 'create'}
                disabled={!batchPlan || batchPlan.createCount === 0}
                onClick={handleBatchCreate}
              >
                创建{batchPlan ? ` ${batchPlan.createCount} 条` : ''}
              </Button>
            </Flex>
          </Flex>
        }
      >
        <Form
          form={batchForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ entryServerIds: [], targetKeys: [], includeInSub: true }}
        >
          <Form.Item
            name="entryServerIds"
            label="入口机(可多选,对外暴露端口的机器)"
            rules={[{ required: true, message: '请选择入口机' }]}
            extra="每台入口机都会为下面选中的每个节点生成一条规则;端口从该机的可用端口白名单里取"
          >
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="选择入口机"
              options={serverOptions(relayServers.length ? relayServers : servers)}
            />
          </Form.Item>
          <Form.Item
            name="targetKeys"
            label="落地节点(可多选)"
            rules={[{ required: true, message: '请选择落地节点' }]}
            extra={
              <Flex gap={8} align="center">
                <Typography.Text type="secondary">socks / http / tunnel 不进订阅,不参与中转</Typography.Text>
                <Button size="small" type="link" onClick={() => batchForm.setFieldValue('targetKeys', targetOptions.map((o) => o.value))}>
                  全选 {targetOptions.length} 个节点
                </Button>
              </Flex>
            }
          >
            <Select mode="multiple" showSearch optionFilterProp="label" placeholder="选择落地节点" options={targetOptions} />
          </Form.Item>
          <Flex gap={16}>
            <Form.Item name="mechanism" label="转发机制" style={{ flex: 1 }} extra="留空 = 跟随各入口机自己的设置">
              <Select
                allowClear
                placeholder="跟随入口机设置"
                options={[
                  { value: 'socat', label: 'socat(推荐,容器环境通用)' },
                  { value: 'iptables', label: 'iptables DNAT(仅独立内核机器)' },
                ]}
              />
            </Form.Item>
            <Form.Item name="includeInSub" label="加入订阅" valuePropName="checked" style={{ flex: 1 }}>
              <Switch />
            </Form.Item>
          </Flex>
        </Form>

        {batchPlan && (
          <Flex vertical gap={8}>
            <Alert
              type={batchPlan.createCount ? 'info' : 'warning'}
              showIcon
              message={`将创建 ${batchPlan.createCount} 条,跳过 ${batchPlan.skipCount} 条`}
              description="端口已按入口机的可用端口白名单分配;点「创建」才会真正写入机器。"
            />
            <Table<ForwardBatchItem>
              rowKey="key"
              size="small"
              pagination={false}
              scroll={{ y: 260 }}
              dataSource={batchPlan.items}
              columns={batchColumns}
            />
          </Flex>
        )}
      </Modal>

      {/* 拓扑:自动中转的期望规则与差异 */}
      <Modal title="中转拓扑(自动规则)" open={topologyOpen} onCancel={() => setTopologyOpen(false)} footer={null} width={760}>
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            message="节点自动中转"
            description="每个节点占用一个全局唯一端口,所有中转机自动生成到达它的转发规则(IPv6-only 落地机经双栈机两跳)。节点/机器变更后 3 秒自动同步。"
          />
          {topology && (
            <>
              <Typography.Text strong>机器 IP 栈</Typography.Text>
              <Flex gap={8} wrap>
                {topology.machines.map((m) => (
                  <Tag key={m.id} color={m.ipStack === 'dual' ? 'green' : m.ipStack === 'unknown' ? 'default' : 'blue'}>
                    {m.name}: {m.ipStack} / {m.relayMechanism}
                    {m.portAllow.length
                      ? ` / NAT ${m.portAllow.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join(',')}`
                      : ''}
                  </Tag>
                ))}
              </Flex>
              {topology.machines.some((m) => m.ipStack === 'unknown') && (
                <Alert
                  type="warning"
                  showIcon
                  message="有机器 IP 栈未知,无法计算其链路"
                  action={
                    <Button size="small" onClick={async () => { const r = await api.detectIpStacks(); message.success(r.summary); setTopology(await api.getTopology()); }}>
                      重新探测
                    </Button>
                  }
                />
              )}
              {topology.skipped.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`${topology.skipped.length} 个节点因「可用端口白名单」未生成中转`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {topology.skipped.slice(0, 6).map((s) => (
                        <li key={`${s.nodeId}-${s.machineId}`}>{s.reason}</li>
                      ))}
                      {topology.skipped.length > 6 && <li>…等共 {topology.skipped.length} 条</li>}
                    </ul>
                  }
                />
              )}
              {topology.portAllowWarnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`${topology.portAllowWarnings.length} 个节点端口不在自己机器的白名单内(不会自动改号)`}
                  description={topology.portAllowWarnings
                    .slice(0, 8)
                    .map((w) => `${w.nodeName} :${w.port} @ ${w.machineName}`)
                    .join('、')}
                />
              )}
              <Typography.Text strong>期望规则({topology.desired.length} 条,含两跳中间规则)</Typography.Text>
              <Table<api.TopologyRule>
                rowKey={(r) => `${r.entryServerId}-${r.entryPort}-${r.landingServerId}-${r.targetPort}`}
                size="small"
                pagination={false}
                scroll={{ y: 260 }}
                dataSource={topology.desired}
                columns={[
                  { title: '入口机', dataIndex: 'entryName', width: 110 },
                  { title: '端口', key: 'p', width: 80, render: (_, r) => <Typography.Text code>{r.entryPort}</Typography.Text> },
                  { title: '→ 落地机', dataIndex: 'landingName', width: 110 },
                  {
                    title: '核心',
                    dataIndex: 'core',
                    width: 80,
                    render: (c: string) => (
                      <Tag color={c === 'singbox' ? 'geekblue' : 'purple'}>{c === 'singbox' ? 'SingBox' : 'Xray'}</Tag>
                    ),
                  },
                  { title: '类型', dataIndex: 'targetNodeType', width: 90, render: (v: string) => (v === 'port' ? <Tag>中间跳</Tag> : <Tag color="green">线路</Tag>) },
                  { title: '进订阅', key: 'sub', width: 70, render: (_, r) => (r.includeInSub ? '✓' : '—') },
                ]}
              />
              <Flex gap={8} align="center">
                <Button type="primary" icon={<SyncOutlined />} loading={syncing} onClick={handleSyncTopology}>
                  立即同步
                </Button>
                <Typography.Text type={topology.diff.toCreate || topology.diff.toDelete ? 'warning' : 'secondary'}>
                  {topology.diff.toCreate || topology.diff.toDelete
                    ? `待同步:新增 ${topology.diff.toCreate} 条,删除 ${topology.diff.toDelete} 条`
                    : '已与期望一致'}
                </Typography.Text>
              </Flex>
            </>
          )}
        </Flex>
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
