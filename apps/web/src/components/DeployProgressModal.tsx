import { Alert, Modal, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';
import type { DeployAllResult } from '../services/types';

interface DeployProgressModalProps {
  open: boolean;
  jobId: string | null;
  onClose: () => void;
  onFinished: () => void;
}

/** 「部署全部」实时进度:按机器轮询后台任务,完成后展示逐机结果 */
export function DeployProgressModal({ open, jobId, onClose, onFinished }: DeployProgressModalProps) {
  const [machines, setMachines] = useState<api.DeployJobMachine[]>([]);
  const [done, setDone] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!open || !jobId) return;
    finishedRef.current = false;
    setDone(false);
    setNotFound(false);
    let stop = false;
    const poll = async () => {
      try {
        const job = await api.getDeployJob(jobId);
        if (stop) return;
        setMachines(job.machines);
        if (job.done) {
          setDone(true);
          if (!finishedRef.current) {
            finishedRef.current = true;
            onFinished();
          }
          return;
        }
      } catch {
        if (stop) return;
        setNotFound(true);
        return;
      }
      setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId]);

  const results: DeployAllResult[] = machines
    .filter((m) => m.result)
    .map((m) => m.result!);

  const columns: ColumnsType<api.DeployJobMachine> = [
    { title: '机器', dataIndex: 'name', width: 140, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (_, m) => {
        if (m.status === 'pending') return <Tag color="processing">排队中…</Tag>;
        const r = m.result;
        if (!r) return <Tag>—</Tag>;
        const sbOk = r.singbox?.ok;
        const xrOk = !r.xray || r.xray.ok || r.xray.skipped;
        return sbOk && xrOk ? <Tag color="success">完成</Tag> : <Tag color="error">失败</Tag>;
      },
    },
    {
      title: 'sing-box / xray',
      key: 'cores',
      render: (_, m) => {
        const r = m.result;
        if (m.status === 'pending' || !r) return <Typography.Text type="secondary">等待…</Typography.Text>;
        return (
          <Typography.Text>
            sing-box: {r.singbox?.ok ? <Tag color="success">OK</Tag> : <Tag color="error">失败</Tag>}　xray:{' '}
            {!r.xray || r.xray.skipped ? <Tag>跳过</Tag> : r.xray.ok ? <Tag color="success">OK</Tag> : <Tag color="error">失败</Tag>}
          </Typography.Text>
        );
      },
    },
    {
      title: '失败原因',
      key: 'error',
      render: (_, m) => {
        const errors = [m.result?.singbox?.error, m.result?.xray?.error].filter(Boolean) as string[];
        return errors.length ? <Typography.Text type="danger">{errors.join(';')}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>;
      },
    },
  ];

  return (
    <Modal
      open={open}
      title={done ? '部署全部 — 完成' : '部署全部 — 进行中'}
      footer={null}
      onCancel={onClose}
      width={760}
      maskClosable={false}
    >
      {notFound ? (
        <Alert type="error" showIcon message="部署任务不存在或已过期(面板可能已重启),请重新发起。" />
      ) : (
        <>
          {!done && (
            <Alert
              type="info"
              showIcon
              message="部署进行中…"
              description="并发逐机下发(每台含校验/备份/重启/健康检查),全程约 2~3 分钟。可关闭此窗口,部署会在后台继续。"
              style={{ marginBottom: 12 }}
            />
          )}
          {done && (
            <Alert
              type={results.every((r) => r.singbox?.ok && (!r.xray || r.xray.ok || r.xray.skipped)) ? 'success' : 'warning'}
              showIcon
              message="部署完成"
              style={{ marginBottom: 12 }}
            />
          )}
          <Table<api.DeployJobMachine> rowKey="serverId" columns={columns} dataSource={machines} pagination={false} size="small" />
        </>
      )}
    </Modal>
  );
}
