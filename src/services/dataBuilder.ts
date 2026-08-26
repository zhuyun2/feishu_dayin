import { bitable, FieldType } from '@lark-base-open/js-sdk';
import type { FieldMetaLite, PrintDataResult, PrintDataValue, LinkedRow } from '../types';
import { amountToChinese } from './money';

const MAX_LINKED_RECORDS = 50; // 单个关联字段最多展开条数
const CONCURRENCY = 10; // 关联记录读取并发上限

const LINK_TYPES = [FieldType.SingleLink, FieldType.DuplexLink]; // 18 / 21

// 分块并发执行，控制对 bridge 的调用洪峰
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 展开一个关联字段：读取子表记录，返回子记录数组
async function expandLinkField(
  parentTable: any,
  meta: FieldMetaLite,
  recordId: string,
  warnings: string[]
): Promise<LinkedRow[]> {
  let cell: any;
  try {
    cell = await parentTable.getCellValue(meta.id, recordId);
  } catch (e) {
    return [];
  }
  if (!cell || !Array.isArray(cell.recordIds) || cell.recordIds.length === 0) return [];

  const linkedTableId = meta.property?.tableId || cell.tableId;
  if (!linkedTableId) {
    warnings.push(`关联字段「${meta.name}」无法确定关联表，已跳过展开`);
    return [];
  }

  let recordIds: string[] = cell.recordIds;
  if (recordIds.length > MAX_LINKED_RECORDS) {
    warnings.push(`关联字段「${meta.name}」有 ${recordIds.length} 条记录，仅展开前 ${MAX_LINKED_RECORDS} 条`);
    recordIds = recordIds.slice(0, MAX_LINKED_RECORDS);
  }

  let childTable: any;
  let childMetas: FieldMetaLite[];
  try {
    childTable = await bitable.base.getTableById(linkedTableId);
    childMetas = (await childTable.getFieldMetaList()) as unknown as FieldMetaLite[];
  } catch (e: any) {
    warnings.push(`关联字段「${meta.name}」的关联表读取失败：${e?.message || e}`);
    return [];
  }

  const rows = await mapLimit(recordIds, CONCURRENCY, async (childRecId, idx) => {
    const row: LinkedRow = { 序号: idx + 1 };
    // 子表字段逐一取显示字符串（子表内的关联字段不再递归，直接取其汇总文本）
    await Promise.all(
      childMetas.map(async (cm) => {
        try {
          row[cm.name] = await childTable.getCellString(cm.id, childRecId);
        } catch (e) {
          row[cm.name] = '';
        }
      })
    );
    return row;
  });

  return rows;
}

// 构建填充数据：普通字段 → 显示串；关联字段 → 子记录数组（+ _文本 汇总变体）
export async function buildPrintData(
  table: any,
  tableName: string,
  fieldMetas: FieldMetaLite[],
  recordId: string
): Promise<PrintDataResult> {
  const warnings: string[] = [];
  const data: Record<string, PrintDataValue> = {};

  // 系统变量（先写入，真实同名字段可覆盖）
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  data['打印日期'] = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  data['打印时间'] = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  data['数据表名称'] = tableName;
  data['记录ID'] = recordId;

  await mapLimit(fieldMetas, CONCURRENCY, async (meta) => {
    // 关联字段：展开为子记录数组
    if (LINK_TYPES.indexOf(meta.type) !== -1) {
      let summaryText = '';
      try {
        const cell: any = await table.getCellValue(meta.id, recordId);
        summaryText = cell && typeof cell.text === 'string' ? cell.text : '';
      } catch (e) {
        summaryText = '';
      }
      const rows = await expandLinkField(table, meta, recordId, warnings);
      data[meta.name] = rows; // 循环变量
      data[`${meta.name}_文本`] = summaryText; // 不写循环也可打成一段文本
      return;
    }

    // Checkbox：getCellString 输出不确定，改用取值转 是/否
    if (meta.type === FieldType.Checkbox) {
      try {
        const v: any = await table.getCellValue(meta.id, recordId);
        data[meta.name] = v ? '是' : '否';
      } catch (e) {
        data[meta.name] = '';
      }
      return;
    }

    // 其余字段：统一取显示字符串
    try {
      data[meta.name] = await table.getCellString(meta.id, recordId);
    } catch (e) {
      data[meta.name] = '';
    }
  });

  // 派生变量：金额大写。
  // 为每个名字里含“金额/合计金额/总价/总金额”的数值字段生成 “<字段名>大写”，
  // 并额外提供通用别名 {金额大写}（取第一个可解析的金额字段）。
  const moneyFieldNames = Object.keys(data).filter((k) =>
    /金额|总价|总金额|应收|应付|价税合计/.test(k) && !/大写/.test(k)
  );
  let firstUpper = '';
  for (const k of moneyFieldNames) {
    const v = data[k];
    if (Array.isArray(v)) continue;
    const upper = amountToChinese(v);
    if (upper) {
      data[`${k}大写`] = upper;
      if (!firstUpper) firstUpper = upper;
    }
  }
  if (firstUpper && data['金额大写'] == null) data['金额大写'] = firstUpper;

  return { data, warnings };
}
