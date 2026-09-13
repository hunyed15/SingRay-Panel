const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * 相对时间展示(最近探测时间):
 * 60s 内 → 刚刚;<7 天 → n 分钟/小时/天前;≥7 天 → 完整日期时间。
 * 空值/非法值 → '-'
 */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '-';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '-';
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  if (abs >= 7 * 24 * 3600_000) return dateFmt.format(new Date(t));
  if (abs >= 24 * 3600_000) return rtf.format(Math.round(diffMs / (24 * 3600_000)), 'day');
  if (abs >= 3600_000) return rtf.format(Math.round(diffMs / 3600_000), 'hour');
  if (abs >= 60_000) return rtf.format(Math.round(diffMs / 60_000), 'minute');
  return rtf.format(Math.round(diffMs / 1000), 'second');
}
