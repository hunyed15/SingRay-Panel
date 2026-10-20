// 从备份恢复数据库(必须先停面板)。
//
// 用法:npm run restore -- <备份文件路径>
// 备份默认在数据库同目录的 backups/ 下,文件名形如 panel-20261019-040000.db。
//
// 恢复不需要密钥,而最需要恢复的时候往往正是 .env 坏掉的时候 —— 所以这里
// 跳过弱密钥守卫(只影响本脚本进程,不影响面板进程),并按需自行解析数据库路径。
process.env.PANEL_ALLOW_WEAK_SECRETS = '1';

const { restoreFromBackup } = await import('../core/backup.js');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAW_DB = process.env.PANEL_DB ?? './data/panel.db';
const DB_PATH = RAW_DB === ':memory:' ? RAW_DB : path.resolve(DIR, '../../..', RAW_DB);

const file = process.argv[2];
if (!file) {
  console.error('用法:npm run restore -- <备份文件路径>');
  console.error('备份默认在数据库同目录的 backups/ 下(文件名形如 panel-YYYYMMDD-HHMMSS.db)');
  process.exit(1);
}

try {
  const r = restoreFromBackup(path.resolve(file), DB_PATH);
  console.log(`已从 ${r.restoredFrom} 恢复(${r.bytes} 字节)`);
  if (r.snapshot) console.log(`恢复前的库已另存为:${r.snapshot}`);
  console.log('现在可以重新启动面板。');
} catch (err) {
  console.error(`恢复失败:${(err as Error).message}`);
  process.exit(1);
}
