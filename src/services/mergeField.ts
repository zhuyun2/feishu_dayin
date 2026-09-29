import type {
  MergeRule, MergeCondition, MergeCondOp, MergeHit, MergeOutputMode, MergeFieldConfig,
} from '../types';
import { DEFAULT_MERGE_RULE } from '../types';
import { parseAmount } from './money';

// ============================================================================
// 合并字段（复合占位符）
// ----------------------------------------------------------------------------
// 模板里写：{{细菌数量}{细菌乘方}}
//   结构 = 一对「外层花括号」包住若干个普通 {字段} 占位符：
//          {  {细菌数量}  {细菌乘方}  }
//   含义 = 把这段整体替换成一个单花括号标签，并按「输出规则」算出一个值填进去。
//   - 内层字段顺序敏感：默认第 1 个当尾数、第 2 个当指数
//   - 至少 2 个内层字段才算合并字段（1 个的话与普通占位符无异，避免误判）
//   - 输出规则可按条件判断（并/或 + 比较符），并支持科学计数法等输出格式
//
// 为什么不能直接丢给 docxtemplater：
//   docxtemplater 的花括号解析会把这段当成畸形标签，必须先在 XML 层把整段换成
//   {__MERGEn} 这种规整标签，值由本模块算好注入数据。
//
// XML 层面的难点：Word 保存时会按拼写/字体把一行文字切成多个 <w:t> run，
// `{{细菌`、`数量}{细菌乘方}}` 可能分散在不同 run 里。因此这里不直接对原始 XML
// 跑正则，而是先构造一个「跳过标签的文本流 + 文本下标→原始下标」的映射表：
//   - 命中区间完全落在单个 <w:t> 内 → 等价于原地替换，run 格式原样保留
//   - 命中区间跨 run → 把区间连同其中的标签一起替换掉，等价于合并为一个 run
//     （保留首个 run 的格式），跨 run 拆分的占位符因此也能正常识别
// ============================================================================

// 外层一对花括号 + 至少两个内层 {字段}
export const MERGE_RE = /\{((?:\{[^{}]*\}){2,})\}/g;

// 合并字段最少需要的字段个数
export const MERGE_MIN_FIELDS = 2;

const INNER_RE = /\{([^{}]*)\}/g;

function unescapeXml(s: string): string {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ============ 签名 ============

// 字段名 → 签名（占位符内的顺序即签名顺序）
export function mergeSignature(fields: string[]): string {
  return fields.join('|');
}

// 签名 → 字段名数组
export function signatureFields(signature: string): string[] {
  if (!signature) return [];
  return signature.split('|').map((s) => s.trim()).filter(Boolean);
}

// 花括号内层文本 → 字段名数组，如 "{细菌数量}{细菌乘方}" → ['细菌数量','细菌乘方']
export function parseMergeInner(inner: string): string[] {
  const names: string[] = [];
  INNER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INNER_RE.exec(inner)) !== null) {
    const name = unescapeXml(m[1]).trim();
    if (name) names.push(name);
  }
  return names;
}

// ============ 跳标签的文本流 ============

interface TextStream {
  text: string;
  map: number[]; // 文本下标 → 原始 XML 下标
}

// 把 XML 拆成「标签段」与「文本段」，只把文本段拼成可搜索的串，
// 同时记录每个文本字符在原始 XML 中的位置，便于回填替换区间。
function buildTextStream(xml: string): TextStream {
  const parts: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      for (let k = i; k < xml.length; k++) { parts.push(xml[k]); map.push(k); }
      break;
    }
    for (let k = i; k < lt; k++) { parts.push(xml[k]); map.push(k); }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break; // 末尾残缺标签，丢弃
    i = gt + 1;
  }
  return { text: parts.join(''), map };
}

// ============ 检测 ============

// 扫描一段 XML（docx 的 document.xml / xlsx 的 sheet 或 sharedStrings），
// 返回按出现顺序去重的复合占位符。
export function scanMerges(xml: string): MergeHit[] {
  const { text } = buildTextStream(xml);
  const seen = new Map<string, MergeHit>();
  MERGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERGE_RE.exec(text)) !== null) {
    const fields = parseMergeInner(m[1]);
    if (fields.length < MERGE_MIN_FIELDS) continue;
    const signature = mergeSignature(fields);
    if (!seen.has(signature)) seen.set(signature, { signature, fields });
  }
  return Array.from(seen.values());
}

// ============ 重写 ============

export interface MergeRewriteResult {
  xml: string;
  order: string[];                    // 出现顺序的签名（传入 registry 时为全局顺序）
  tags: Record<string, string>;       // 签名 → 生成标签名（不含花括号）
}

// 全局标签登记表：docx 的正文与页眉页脚要一起改写，
// 各 part 必须共用同一套编号，否则不同 part 的 __MERGE_1 会撞成不同签名。
export interface MergeRegistry {
  tags: Record<string, string>;
  order: string[];
}

export function createMergeRegistry(): MergeRegistry {
  return { tags: {}, order: [] };
}

// 生成标签名：纯 ASCII，避免字段名里的特殊字符影响 docxtemplater 解析
export function makeMergeTag(index: number): string {
  return `__MERGE_${index + 1}`;
}

// 把 XML 里的全部复合占位符替换为 {标签}
export function rewriteMergeXml(xml: string, registry?: MergeRegistry): MergeRewriteResult {
  const reg = registry || createMergeRegistry();
  const { text, map } = buildTextStream(xml);
  const spans: { start: number; end: number; tag: string }[] = [];

  MERGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERGE_RE.exec(text)) !== null) {
    const fields = parseMergeInner(m[1]);
    if (fields.length < MERGE_MIN_FIELDS) continue;
    const signature = mergeSignature(fields);
    if (!reg.tags[signature]) {
      reg.tags[signature] = makeMergeTag(reg.order.length);
      reg.order.push(signature);
    }
    spans.push({
      start: map[m.index],
      end: map[m.index + m[0].length - 1] + 1,
      tag: reg.tags[signature],
    });
  }

  if (!spans.length) return { xml, order: reg.order, tags: reg.tags };

  // 从后往前替换，前面的区间下标不受影响
  let out = xml;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    out = out.slice(0, s.start) + `{${s.tag}}` + out.slice(s.end);
  }
  return { xml: out, order: reg.order, tags: reg.tags };
}

// ============ 条件判断 ============

// 两边都能解析成数字时按数值比较，否则按去除首尾空格的字符串比较
function compareValues(left: string, op: MergeCondOp, right: string): boolean {
  const l = (left ?? '').trim();
  const r = (right ?? '').trim();
  switch (op) {
    case 'notEmpty':
      return l !== '';
    case 'contains':
      return r === '' ? false : l.includes(r);
    case 'eq':
    case 'ne': {
      const ln = parseAmount(l);
      const rn = parseAmount(r);
      const bothNum = isFinite(ln) && isFinite(rn);
      const eq = bothNum ? ln === rn : l === r;
      return op === 'eq' ? eq : !eq;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const ln = parseAmount(l);
      const rn = parseAmount(r);
      if (!isFinite(ln) || !isFinite(rn)) return false;
      if (op === 'gt') return ln > rn;
      if (op === 'gte') return ln >= rn;
      if (op === 'lt') return ln < rn;
      return ln <= rn;
    }
    default:
      return false;
  }
}

// 条件是否全部/任一满足。无条件 = 视为满足（无条件输出）。
export function evaluateConditions(rule: MergeRule | undefined, getValue: (field: string) => string): boolean {
  const conds = ((rule?.conditions || []) as MergeCondition[]).filter((c) => c && c.field);
  if (!conds.length) return true;
  const results = conds.map((c) => compareValues(getValue(c.field), c.op, c.value ?? ''));
  return rule?.join === 'or' ? results.some(Boolean) : results.every(Boolean);
}

// ============ 输出格式 ============

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '-': '⁻', '−': '⁻', '+': '⁺',
};

export function toSuperscript(s: string): string {
  return String(s).split('').map((c) => SUPERSCRIPT[c] ?? c).join('');
}

// 数字格式化：指定小数位则固定，否则整数原样、小数最多保留 6 位且去掉多余 0
export function formatMergeNumber(n: number, precision?: number | null): string {
  if (!isFinite(n)) return '';
  if (typeof precision === 'number' && precision >= 0) return n.toFixed(precision);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

// 算出某个签名的输出值。
// 未配置规则时退化为「直接紧密拼接各字段值」，保证模板不会输出原始的 {{...}}。
export function buildMergeValue(
  rule: MergeRule | undefined,
  fields: string[],
  getValue: (field: string) => string
): string {
  const out = rule?.output;
  const fallback = out?.fallback ?? '';
  if (rule && !evaluateConditions(rule, getValue)) return fallback;

  const mode: MergeOutputMode = out?.mode ?? 'concat';

  if (mode === 'concat') {
    return fields.map((f) => getValue(f)).join(out?.separator ?? '');
  }

  // scientific / product：尾数与指数默认取占位符第 1、2 个字段
  const mantissaField = out?.mantissaField || fields[0] || '';
  const exponentField = out?.exponentField || fields[1] || fields[0] || '';
  const mantissa = parseAmount(getValue(mantissaField));
  const exponent = parseAmount(getValue(exponentField));
  if (!isFinite(mantissa) || !isFinite(exponent)) return fallback;

  if (mode === 'product') {
    return formatMergeNumber(mantissa * Math.pow(10, exponent), out?.precision);
  }

  const mantText = formatMergeNumber(mantissa, out?.precision);
  const expText = formatMergeNumber(exponent, null);
  const times = out?.times || '×10';
  const expPart = out?.superscript === false ? `^${expText}` : toSuperscript(expText);
  return `${mantText}${times}${expPart}`;
}

// 供填充引擎使用的解析器：签名 + 字段名 → 输出值
export function makeMergeResolver(
  rules: MergeFieldConfig | undefined,
  readField: (field: string) => string
): (signature: string, fields: string[]) => string {
  return (signature, fields) => buildMergeValue(rules?.[signature], fields, readField);
}

// ============ 供 UI 使用 ============

// 补全规则的缺省部分（读取旧配置 / 新建规则时统一走这里）
export function normalizeMergeRule(rule: MergeRule | undefined): MergeRule {
  return {
    join: rule?.join === 'or' ? 'or' : 'and',
    conditions: (rule?.conditions || []).map((c) => ({
      field: c.field || '',
      op: c.op || 'eq',
      value: c.value ?? '',
    })),
    output: {
      mode: rule?.output?.mode || DEFAULT_MERGE_RULE.output.mode,
      separator: rule?.output?.separator ?? '',
      mantissaField: rule?.output?.mantissaField || '',
      exponentField: rule?.output?.exponentField || '',
      superscript: rule?.output?.superscript !== false,
      times: rule?.output?.times || '×10',
      precision: typeof rule?.output?.precision === 'number' ? rule.output.precision : null,
      fallback: rule?.output?.fallback ?? '',
    },
  };
}

const OP_SIGN: Record<MergeCondOp, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: '包含', notEmpty: '非空',
};

// 规则的文字描述（界面提示用，不取值）
export function describeMergeRule(rule: MergeRule | undefined, fields: string[]): string {
  if (!rule) return '';
  const conds = (rule.conditions || []).filter((c) => c.field);
  const condText = conds
    .map((c) => (c.op === 'notEmpty' ? `${c.field}非空` : `${c.field} ${OP_SIGN[c.op] || '='} ${c.value ?? ''}`))
    .join(rule.join === 'or' ? ' 或 ' : ' 且 ');

  const out = rule.output;
  const mantissa = out.mantissaField || fields[0] || '尾数';
  const exponent = out.exponentField || fields[1] || fields[0] || '指数';
  const outText = out.mode === 'concat'
    ? `直接拼接${out.separator ? `（连接符「${out.separator}」）` : ''}`
    : out.mode === 'product'
      ? `数值乘积（${mantissa} × 10 的 ${exponent} 次方）`
      : `科学计数法（${mantissa} × 10 的 ${exponent} 次方）`;

  return condText ? `${condText} → ${outText}` : outText;
}
