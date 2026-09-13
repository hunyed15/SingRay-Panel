import { Modal, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DeployAllResult } from '../services/types';

interface DeployResultModalProps {
  open: boolean;
  results: DeployAllResult[];
  onClose: () => void;
}

/** 「部署全部」结果:每台机器 singbox / xray 双核部署状态 + 失败原因 */
export function DeployResultModal({ open, results, onClose }: DeployResultModalProps) {
  const columns: ColumnsType<DeployAllResult> = [
    {
      title: '机器',
      dataIndex: 'serverName',
      width: 140,
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: 'sing-box',
      key: 'singbox',
      width: 110,
      render: (_, r) =>
        r.singbox?.ok ? <Tag color="success">OK</Tag> : <Tag color="error">失败</Tag>,
    },
    {
      title: 'xray',
      key: 'xray',
      width: 110,
      render: (_, r) => {
        if (!r.xray || r.xray.skipped) return <Tag>跳过</Tag>;
        return r.xray.ok ? <Tag color="success">OK</Tag> : <Tag color="error">失败</Tag>;
      },
    },
    {
      title: '失败原因',
      key: 'error',
      render: (_, r) => {
        const errors = [r.singbox?.error, r.xray?.error].filter(Boolean) as string[];
        return errors.length ? (
          <Typography.Text type="danger">{errors.join(';')}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
      },
    },
  ];

  const allOk = results.every(
    (r) => r.singbox?.ok && (!r.xray || r.xray.ok || r.xray.skipped),
  );

  return (
    <Modal
      open={open}
      title={allOk ? '部署全部 — 完成' : '部署全部 — 部分失败'}
      footer={null}
      width={680}
      onCancel={onClose}
    >
      <Table<DeployAllResult>
        rowKey="serverId"
        columns={columns}
        dataSource={results}
        pagination={false}
        size="small"
        locale={{ emptyText: '没有部署结果' }}
      />
    </Modal>
  );
}
