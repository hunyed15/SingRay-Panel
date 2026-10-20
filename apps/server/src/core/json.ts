// 响应序列化层的 key 归一:D1 里数据库行是 snake_case,API 面统一 camelCase。
//
// 只改 key,不动值;只处理普通对象/数组(字符串、Buffer、Date 原样返回)。
// 幂等:已经是 camelCase 的 key 不会再变 —— 所以本来就用 camelCase 的视图 DTO
// (拓扑预览、批量计划)过一遍也无副作用。

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

export const toCamelKey = (key: string): string => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export function camelize<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => camelize(v)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[toCamelKey(k)] = camelize(v);
  return out as T;
}
