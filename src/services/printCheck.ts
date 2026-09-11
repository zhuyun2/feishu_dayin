import type { FieldMetaLite } from '../types';

// ============ 打印前字段校验 ============
// 场景：表格多条数据时，无法判断哪条可以打印。可在多维表加一个「审核」字段，
// 当字段值为「通过」/「已审核」等允许值时，打印插件才允许打印，否则提示拦截。
// 校验字段与允许值可在插件内自行设置（模板页），按表持久化到 /api/config。

// 读取当前记录某个字段的「显示字符串」，供校验值比对。
export async function readFieldText(
  table: any,
  fieldId: string,
  recordId: string
): Promise<string> {
  try {
    const s = await table.getCellString(fieldId, recordId);
    return s == null ? '' : String(s);
  } catch (e) {
    return '';
  }
}

// 校验结果
export interface PrintCheckResult {
  ok: boolean;          // 是否允许打印
  fieldValue: string;   // 当前字段值（提示用）
  message?: string;     // 拦截原因
}

// 根据当前记录字段值判断是否允许打印。
// - enabled=false：不校验，直接放行。
// - 未选择字段或未配置允许值：放行（避免误拦截）。
// - 字段值与任一允许值相等（忽略首尾空格）→ 放行；否则拦截。
export async function checkPrintAllowed(params: {
  enabled: boolean;
  fieldId?: string;
  allowedValues?: string[];
  table: any;
  fieldMetas: FieldMetaLite[];
  recordId: string;
}): Promise<PrintCheckResult> {
  const { enabled, fieldId, allowedValues, table, fieldMetas, recordId } = params;

  if (!enabled || !fieldId || !allowedValues || allowedValues.length === 0) {
    return { ok: true, fieldValue: '' };
  }

  const fieldValue = await readFieldText(table, fieldId, recordId);
  const fieldName = fieldMetas.find((f) => f.id === fieldId)?.name || '校验字段';
  const normalized = (fieldValue || '').trim();
  const allowed = allowedValues.some((v) => (v || '').trim() === normalized);

  if (allowed) {
    return { ok: true, fieldValue };
  }
  return {
    ok: false,
    fieldValue,
    message: `当前记录「${fieldName}」为「${fieldValue || '空'}」，不允许打印。需为：${allowedValues.map((v) => `「${v}」`).join(' / ')}`,
  };
}
