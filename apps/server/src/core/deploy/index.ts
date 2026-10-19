// Transactional deploy engine (design.md §3). Ported from singbox-panel
// deploy.js / deployXray.js semantics, formalized into structured steps:
//   render → upload → verify → backup → swap → restart → health
// Any failure before swap leaves production untouched; failure after swap
// triggers rollback (restore .bak + restart) and reports rolledBack:true.

import type { SshConn, ExecFn } from '../ssh/executor.js';
import { exec, writeFile } from '../ssh/executor.js';

export type DeployCore = 'singbox' | 'xray';
export type DeployStepName =
  | 'render'
  | 'upload'
  | 'verify'
  | 'verify-skip'
  | 'backup'
  | 'swap'
  | 'restart'
  | 'restart-fallback'
  | 'health'
  | 'health-fail'
  | 'rollback'
  | 'rollback-skip';

export interface DeployStep {
  step: DeployStepName;
  ok: boolean;
  detail?: string;
}

export interface DeployResult {
  ok: boolean;
  steps: DeployStep[];
  error?: string;
  rolledBack: boolean;
  /** last 20 journal lines when health fails, for diagnosis */
  journal?: string;
}

export interface CorePaths {
  bin: string;
  config: string;
  unit: string;
}

export const SINGBOX_DEFAULTS: CorePaths = { bin: '/usr/local/bin/sing-box', config: '/etc/sing-box/config.json', unit: 'sing-box' };
export const XRAY_DEFAULTS: CorePaths = { bin: '/usr/local/bin/xray', config: '/etc/xray/config.json', unit: 'xray' };

const TMP_DIR: Record<DeployCore, string> = { singbox: '/tmp/singray-singbox', xray: '/tmp/singray-xray' };

export interface DeployOpts {
  core: DeployCore;
  config: Record<string, unknown>;
  paths?: Partial<CorePaths>;
  /** injectable for tests */
  execFn?: ExecFn;
  writeFileFn?: typeof writeFile;
}

export async function deployCore(conn: SshConn, opts: DeployOpts): Promise<DeployResult> {
  const execFn = opts.execFn ?? exec;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const core = opts.core;
  const paths: CorePaths = { ...(core === 'singbox' ? SINGBOX_DEFAULTS : XRAY_DEFAULTS), ...opts.paths };
  const tmp = `${TMP_DIR[core]}/config.json`;
  const steps: DeployStep[] = [];
  const step = (name: DeployStepName, ok: boolean, detail?: string) => steps.push({ step: name, ok, detail });

  // render (local, pure — configgen output arrives as an object)
  const json = JSON.stringify(opts.config, null, 2);
  step('render', true, `${json.length} bytes`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const doStep = async (name: DeployStepName, fn: () => Promise<void>) => {
    try {
      await fn();
      step(name, true);
    } catch (err) {
      step(name, false, (err as Error).message);
      throw err;
    }
  };

  /**
   * 是否存在可回滚的旧配置。
   * 首次部署没有旧配置 —— 这不是错误,但意味着回滚时不能谎称"已回滚"。
   */
  let hasBackup = false;

  try {
    await doStep('upload', async () => {
      await execFn(conn, `mkdir -p ${TMP_DIR[core]}`, { timeoutClass: 'quick' });
      await writeFileFn(conn, tmp, json, execFn);
    });

    if (core === 'singbox') {
      await doStep('verify', () => execFn(conn, `${paths.bin} check -c ${tmp}`, { timeoutClass: 'config' }).then(() => {}));
    } else {
      // xray run -test 与部分版本不兼容,跳过本地校验;restart 后 health 兜底
      step('verify-skip', true, 'xray -test compatibility; health check covers it');
    }

    // 备份:区分「没有旧配置」与「备份失败」。旧实现用 `|| true` 让两者都静默通过,
    // 结果是首次部署时既没有 .bak,回滚又报成功。
    await doStep('backup', async () => {
      const r = await execFn(
        conn,
        `if [ -f ${paths.config} ]; then cp -f ${paths.config} ${paths.config}.bak && echo BACKED-UP || echo BACKUP-FAILED; else echo NO-CONFIG; fi`,
        { timeoutClass: 'quick' },
      );
      const out = r.stdout.trim();
      if (out.includes('BACKUP-FAILED')) throw new Error(`旧配置备份失败:${paths.config}`);
      hasBackup = out.includes('BACKED-UP');
    });

    // swap:先写 .new 再 mv —— `install` 就地覆盖不是原子操作,断线会留下截断的配置
    await doStep('swap', () =>
      execFn(
        conn,
        `mkdir -p $(dirname ${paths.config}) && install -m 600 ${tmp} ${paths.config}.new && mv -f ${paths.config}.new ${paths.config}`,
        { timeoutClass: 'config' },
      ).then(() => {}),
    );
  } catch (err) {
    return { ok: false, steps, error: (err as Error).message, rolledBack: false };
  }

  /**
   * 回滚并**校验**结果。返回是否真的回到了可用状态:
   * 无旧配置 / 恢复失败 / 恢复后起不来 都返回 false,由调用方如实上报。
   */
  const rollback = async (): Promise<boolean> => {
    if (!hasBackup) {
      step('rollback-skip', true, '首次部署无旧配置可回滚');
      return false;
    }
    try {
      await execFn(conn, `cp -f ${paths.config}.bak ${paths.config}`, { timeoutClass: 'quick' });
      await execFn(conn, `systemctl restart ${paths.unit}`, { timeoutClass: 'config' });
    } catch (err) {
      step('rollback', false, (err as Error).message);
      return false;
    }
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      try {
        const r = await execFn(conn, `systemctl is-active ${paths.unit} || echo inactive`, { timeoutClass: 'quick' });
        if (r.stdout.trim() === 'active') {
          step('rollback', true);
          return true;
        }
      } catch {
        // 传输抖动继续轮询
      }
    }
    step('rollback', false, '恢复旧配置后单元仍未 active');
    return false;
  };

  try {
    if (core === 'singbox') {
      try {
        await execFn(conn, `systemctl reload ${paths.unit}`, { timeoutClass: 'config' });
        step('restart', true, 'reload');
      } catch (err) {
        if ((err as Error).message.includes('not applicable')) {
          // unit 无 ExecReload(旧机器)→ 配置已 check 通过,restart 应用即可
          await execFn(conn, `systemctl restart ${paths.unit}`, { timeoutClass: 'config' });
          step('restart-fallback', true);
        } else {
          throw err;
        }
      }
    } else {
      await execFn(conn, `systemctl restart ${paths.unit}`, { timeoutClass: 'config' });
      step('restart', true);
    }
  } catch (err) {
    const rolledBack = await rollback();
    return { ok: false, steps, error: (err as Error).message, rolledBack };
  }

  // health: systemctl is-active polling (1s × 10) — fixes "restart OK but core dead"
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    try {
      const r = await execFn(conn, `systemctl is-active ${paths.unit} || echo inactive`, { timeoutClass: 'quick' });
      if (r.stdout.trim() === 'active') {
        step('health', true);
        return { ok: true, steps, rolledBack: false };
      }
    } catch {
      // transient ssh hiccup — keep polling
    }
  }
  step('health-fail', false, `unit ${paths.unit} not active after restart`);
  const journal = await execFn(conn, `journalctl -u ${paths.unit} -n 20 --no-pager 2>/dev/null || echo no journalctl`, { timeoutClass: 'quick' })
    .then((r) => r.stdout)
    .catch(() => 'n/a');
  const rolledBack = await rollback();
  return { ok: false, steps, error: `unit ${paths.unit} 未进入 active 状态`, rolledBack, journal: journal.slice(0, 500) };
}
