import { bitable, FieldType } from '@lark-base-open/js-sdk';
import type {
  FieldMetaLite, PrintDataResult, PrintDataValue, LinkedRow, AttachmentFieldData, RawAttachment,
  BuildPrintDataOptions,
} from '../types';
import { amountToChinese } from './money';

const MAX_LINKED_RECORDS = 200; // 单个关联字段最多展开条数
const CONCURRENCY = 10; // 关联记录读取并发上限
const MAX_LINK_DEPTH = 2; // 循环最大层数：顶层关联 + 一层嵌套（模板里可写两层 {#A}{#B}…{/B}{/A}）
const MAX_TOTAL_LINKED_ROWS = 3000; // 一次打印展开的关联记录总量上限（含嵌套，防爆量）

const LINK_TYPES = [FieldType.SingleLink, FieldType.DuplexLink]; // 18 / 21

// 展开过程共享的上下文
interface ExpandCtx {
  // 模板里被用作循环的字段名；只有这些嵌套关联字段才展开成数组。
  // null = 不展开嵌套（调用方未提供 loopFields，保持旧行为）
  loopFields: Set<string> | null;
  // 实际按关联字段展开过的字段名（任意层级），用于反查「模板里写了循环但展不开」的字段
  expanded: Set<string>;
  warnings: string[];
  total: { rows: number };
  budgetWarned: boolean;
}

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

// 展开一个关联字段：读取子表记录，返回子记录数组。
// depth：1 = 直接挂在主记录下的关联字段；2 = 子记录里的关联字段（嵌套循环）。
// 只有 depth<MAX_LINK_DEPTH 且字段名被模板用作循环时，才把子记录里的关联字段继续展开成数组，
// 否则仍取汇总文本，避免「模板没写嵌套循环却多发一堆请求」以及 {字段} 打成 [object Object]。
async function expandLinkField(
  parentTable: any,
  meta: FieldMetaLite,
  recordId: string,
  depth: number,
  ctx: ExpandCtx
): Promise<LinkedRow[]> {
  ctx.expanded.add(meta.name);
  let cell: any;
  try {
    cell = await parentTable.getCellValue(meta.id, recordId);
  } catch (e) {
    return [];
  }
  if (!cell || !Array.isArray(cell.recordIds) || cell.recordIds.length === 0) return [];

  const linkedTableId = meta.property?.tableId || cell.tableId;
  if (!linkedTableId) {
    ctx.warnings.push(`关联字段「${meta.name}」无法确定关联表，已跳过展开`);
    return [];
  }

  let recordIds: string[] = cell.recordIds;
  if (recordIds.length > MAX_LINKED_RECORDS) {
    ctx.warnings.push(`关联字段「${meta.name}」有 ${recordIds.length} 条记录，仅展开前 ${MAX_LINKED_RECORDS} 条`);
    recordIds = recordIds.slice(0, MAX_LINKED_RECORDS);
  }

  // 总量保护：嵌套展开是乘数级的，超出上限就截断并提示，避免一次打印把插件拖死
  const remain = MAX_TOTAL_LINKED_ROWS - ctx.total.rows;
  if (remain <= 0) {
    if (!ctx.budgetWarned) {
      ctx.budgetWarned = true;
      ctx.warnings.push(`关联记录总数超过 ${MAX_TOTAL_LINKED_ROWS} 条，超出部分未展开`);
    }
    return [];
  }
  if (recordIds.length > remain) {
    if (!ctx.budgetWarned) {
      ctx.budgetWarned = true;
      ctx.warnings.push(`关联记录总数超过 ${MAX_TOTAL_LINKED_ROWS} 条，超出部分未展开`);
    }
    recordIds = recordIds.slice(0, remain);
  }
  ctx.total.rows += recordIds.length;

  let childTable: any;
  let childMetas: FieldMetaLite[];
  try {
    childTable = await bitable.base.getTableById(linkedTableId);
    childMetas = (await childTable.getFieldMetaList()) as unknown as FieldMetaLite[];
  } catch (e: any) {
    ctx.warnings.push(`关联字段「${meta.name}」的关联表读取失败：${e?.message || e}`);
    return [];
  }

  const rows = await mapLimit(recordIds, CONCURRENCY, async (childRecId, idx) => {
    const row: LinkedRow = { 序号: idx + 1 };
    // 子表字段逐一取显示字符串；子表内被用作循环的关联字段再递归展开一层
    await Promise.all(
      childMetas.map(async (cm) => {
        if (
          depth < MAX_LINK_DEPTH &&
          LINK_TYPES.indexOf(cm.type) !== -1 &&
          ctx.loopFields !== null &&
          ctx.loopFields.has(cm.name)
        ) {
          let summaryText = '';
          try {
            const sub: any = await childTable.getCellValue(cm.id, childRecId);
            summaryText = sub && typeof sub.text === 'string' ? sub.text : '';
          } catch (e) {
            summaryText = '';
          }
          row[cm.name] = await expandLinkField(childTable, cm, childRecId, depth + 1, ctx);
          row[`${cm.name}_文本`] = summaryText;
          return;
        }
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

// 构建填充数据：普通字段 → 显示串；关联字段 → 子记录数组（+ _文本 汇总变体）；
// opts.loopFields 里列出的子表关联字段会再展开一层，以支持两层嵌套循环；
// 附件字段 → 文件名文本，并把原始附件列表单独回传（由调用方决定是否把图片插入模板）。
export async function buildPrintData(
  table: any,
  tableName: string,
  fieldMetas: FieldMetaLite[],
  recordId: string,
  opts?: BuildPrintDataOptions
): Promise<PrintDataResult> {
  const warnings: string[] = [];
  const data: Record<string, PrintDataValue> = {};
  const attachments: Record<string, AttachmentFieldData> = {};
  // 未传 loopFields = 不展开嵌套（旧行为）；传了（即使是空数组）= 按清单展开
  const ctx: ExpandCtx = {
    loopFields: opts && opts.loopFields ? new Set(opts.loopFields) : null,
    expanded: new Set<string>(),
    warnings,
    total: { rows: 0 },
    budgetWarned: false,
  };

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
      const rows = await expandLinkField(table, meta, recordId, 1, ctx);
      data[meta.name] = rows; // 循环变量
      data[`${meta.name}_文本`] = summaryText; // 不写循环也可打成一段文本
      return;
    }

    // 附件字段：默认输出文件名文本（保持旧行为）；同时把原始附件列表回报，
    // 由调用方按「图片→插图 / 非图片→文件名」决定最终呈现。
    if (meta.type === FieldType.Attachment) {
      try {
        data[meta.name] = await table.getCellString(meta.id, recordId);
      } catch (e) {
        data[meta.name] = '';
      }
      try {
        const cell: any = await table.getCellValue(meta.id, recordId);
        if (Array.isArray(cell) && cell.length) {
          const items: RawAttachment[] = cell
            .filter((a: any) => a && a.token)
            .map((a: any) => ({
              name: String(a.name == null ? '' : a.name),
              size: Number(a.size) || 0,
              type: String(a.type == null ? '' : a.type),
              token: String(a.token),
            }));
          if (items.length > 0) attachments[meta.name] = { fieldId: meta.id, items };
        }
      } catch (e) {
        // 取不到附件明细不影响文件名文本输出
      }
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

  // 模板里写了 {#X} 但 X 不是关联字段（如「引用/Lookup」字段）时，数据层不会给出数组，
  // docxtemplater 会把循环体整段跳过 —— 这种静默失败最容易被误判成「功能没生效」，故显式提示。
  if (ctx.loopFields) {
    const missing = Array.from(ctx.loopFields).filter(
      (n) => n && n !== '.' && !ctx.expanded.has(n)
    );
    if (missing.length > 0) {
      warnings.push(
        `模板里的循环字段「${missing.join('、')}」不是关联字段（子表里也没有该关联字段），该循环不会展开；` +
        `若它是「引用/Lookup」类型的字段，请改用关联字段，或用 {字段_文本} 输出汇总文本`
      );
    }
  }

  return {
    data,
    warnings,
    attachments: Object.keys(attachments).length > 0 ? attachments : undefined,
  };
}
