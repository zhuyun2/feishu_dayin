import type {
  MergeRule, MergeBranch, MergeCondition, MergeCondOp, MergeHit, MergeOutputMode,
  MergeBindOptions, MergeScope, PrintDataValue, LinkedRow, RawMergeRule, MergeOutput,
} from '../types';
import { DEFAULT_MERGE_BRANCH } from '../types';
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

// 扫描一段 XML 里被用作循环的字段名（{#字段}）。
// 与 scanMerges 同理：占位符可能被 Word 按 run 拆开（如 {#F_key | 微检市场需求表 | }），
// 因此走「跳标签的文本流」而非直接正则匹配原始 XML。
// 用途：数据层据此判断哪些嵌套关联字段需要展开成数组（两层循环）。
export function scanLoopFields(xml: string): string[] {
  const { text } = buildTextStream(xml);
  const names = new Set<string>();
  const re = /\{#([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = unescapeXml(m[1]).trim();
    if (name) names.add(name);
  }
  return Array.from(names);
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
// 入参兼容 MergeBranch（新）与旧的 MergeRule（单分支），二者都只用到 join + conditions。
export function evaluateConditions(
  rule: Pick<MergeBranch, 'join' | 'conditions'> | undefined,
  getValue: (field: string) => string
): boolean {
  const conds = ((rule?.conditions || []) as MergeCondition[]).filter((c) => c && c.field);
  if (!conds.length) return true;
  const results = conds.map((c) => compareValues(getValue(c.field), c.op, c.value ?? ''));
  return rule?.join === 'or' ? results.some(Boolean) : results.every(Boolean);
}

// ============ 分支读取（新旧格式兼容）============

// 把一个原始规则（可能是旧版单分支形态）归一成分支数组。
// 旧形态 { join, conditions, output.fallback } 的语义是「条件不满足 → fallback」，
// 迁移时把 fallback 提升为末尾的「无条件固定文本分支」，行为与旧版完全一致。
export function toBranches(rule: RawMergeRule | MergeRule | undefined): MergeBranch[] {
  const r = rule as RawMergeRule | undefined;
  if (!r) return [];
  if (Array.isArray(r.branches)) return r.branches.filter((b) => b && typeof b === 'object');

  const conds = r.conditions || [];
  const out = r.output;
  if (!conds.length && !out) return [];

  const branches: MergeBranch[] = [{
    join: r.join === 'or' ? 'or' : 'and',
    conditions: conds,
    output: normalizeMergeOutput(out),
  }];
  const fb = out?.fallback;
  if (typeof fb === 'string' && fb !== '') {
    branches.push({ join: 'and', conditions: [], output: { mode: 'text', text: fb, fallback: '' } });
  }
  return branches;
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

// 按一种输出设置算出文本。
// 未配置规则时退化为「直接紧密拼接各字段值」，保证模板不会输出原始的 {{...}}。
function renderOutput(
  out: MergeOutput | undefined,
  fields: string[],
  getValue: (field: string) => string
): string {
  const fallback = out?.fallback ?? '';
  const mode: MergeOutputMode = out?.mode ?? 'concat';

  if (mode === 'text') return out?.text ?? '';

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

// 规则是否已配置（区别于「没配过」）：
//   undefined / {}          → 未配置，退化为紧密拼接
//   { branches: [] }        → 已配置但没有分支，输出空串
function isConfigured(rule: RawMergeRule | MergeRule | undefined): boolean {
  if (!rule) return false;
  const r = rule as RawMergeRule;
  if (Array.isArray(r.branches)) return true;
  return !!(r.conditions || r.output);
}

// 算出某个签名的输出值：按分支顺序匹配，第一个条件满足的分支生效；都不命中输出空串。
export function buildMergeValue(
  rule: RawMergeRule | MergeRule | undefined,
  fields: string[],
  getValue: (field: string) => string
): string {
  if (!isConfigured(rule)) return renderOutput(undefined, fields, getValue);

  for (const b of toBranches(rule)) {
    if (evaluateConditions(b, getValue)) return renderOutput(b.output, fields, getValue);
  }
  return '';
}

// 供填充引擎使用的解析器：签名 + 字段名（+ 循环行作用域）→ 输出值
export function makeMergeResolver(
  rules: Record<string, RawMergeRule> | undefined,
  readField: (field: string, scope?: MergeScope) => string
): (signature: string, fields: string[], scope?: MergeScope) => string {
  return (signature, fields, scope) =>
    buildMergeValue(rules?.[signature], fields, (f) => readField(f, scope));
}

// ============ 循环内的取值下沉 ============

// 把生成标签 {__MERGEn} 的取值下沉到每一个明细行。
// 为什么需要：docxtemplater 取值时先在当前行找、找不到才逐级回退外层作用域，
// 而合并字段原先只在顶层算一次 —— 循环里的复合占位符引用的若是子表字段
// （顶层数据里不存在同名键），就会一律算成空串 / fallback。
// 行内写入后，行内值优先，未命中的仍回退到顶层值，顶层行为不变。
//
// 顺带做一次「取不到值」诊断：循环行里引用的字段全为空时，按规则只会输出 fallback
// （未配置就是空），这类静默空白最容易被当成「字段值没获取到」，故汇总提示一次。
export function attachMergeTagsToRows(
  payload: Record<string, PrintDataValue>,
  registry: MergeRegistry,
  merge: MergeBindOptions
): void {
  if (!registry.order.length) return;

  // 预扫：明细行里出现过的普通字段名（用来判断某签名引用的字段是不是「行内字段」）
  const rowKeys = new Set<string>();
  const collect = (rows: LinkedRow[]) => {
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        const v = row[key];
        if (Array.isArray(v)) collect(v as unknown as LinkedRow[]);
        else rowKeys.add(key);
      }
    }
  };
  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (Array.isArray(v)) collect(v as unknown as LinkedRow[]);
  }

  const sigs = registry.order.map((sig) => {
    const fields = signatureFields(sig);
    return { sig, fields, tag: registry.tags[sig], ownedSomewhere: fields.some((f) => rowKeys.has(f)) };
  });
  const blankRows: Record<string, number> = {};

  const walk = (rows: LinkedRow[], ancestors: Record<string, PrintDataValue>[]) => {
    const top = ancestors[0];
    for (const row of rows) {
      // 作用域 = 顶层数据 + 各级外层行 + 当前行（靠后覆盖靠前）
      const scope = Object.assign({}, ...ancestors, row) as Record<string, PrintDataValue>;
      for (const s of sigs) {
        const value = merge.resolve(s.sig, s.fields, scope);
        row[s.tag] = value;
        // 取不到值诊断（只统计真正会渲染成明细的那些行）：
        //   - 行内自带这些字段 → 算不出值就是这一行的问题，计入
        //   - 行内完全没有、顶层也没有 → 字段名对不上，计入
        //   - 纯粹由顶层数据取值（字段都在顶层）→ 不在行计数里重复报，避免噪音
        if (merge.warn && value === '') {
          const ownsAny = s.fields.some((f) => Object.prototype.hasOwnProperty.call(row, f));
          const fromTop = s.fields.every((f) => Object.prototype.hasOwnProperty.call(top, f));
          if (ownsAny || (!fromTop && !s.ownedSomewhere)) {
            blankRows[s.sig] = (blankRows[s.sig] || 0) + 1;
          }
        }
      }
      for (const key of Object.keys(row)) {
        const v = row[key];
        if (Array.isArray(v)) walk(v as unknown as LinkedRow[], [...ancestors, row]);
      }
    }
  };

  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (Array.isArray(v)) walk(v as unknown as LinkedRow[], [payload]);
  }

  if (merge.warn) {
    for (const [sig, count] of Object.entries(blankRows)) {
      const fields = signatureFields(sig);
      merge.warn(
        `合并字段「{{${fields.join('}{')}}}」有 ${count} 行取不到值（${fields.join('、')} 为空或算不出数值），` +
        '这些行按规则输出为空；若希望像其它列一样显示兜底值（如 <10），' +
        '请在「🔗 合并字段」面板末尾添加一个「其他情况」兜底分支，输出方式选「固定文本」'
      );
    }
  }
}

// ============ 供 UI 使用 ============

// 补全输出设置的缺省部分
export function normalizeMergeOutput(out: MergeOutput | undefined): MergeOutput {
  return {
    mode: out?.mode || 'concat',
    separator: out?.separator ?? '',
    mantissaField: out?.mantissaField || '',
    exponentField: out?.exponentField || '',
    superscript: out?.superscript !== false,
    times: out?.times || '×10',
    precision: typeof out?.precision === 'number' ? out.precision : null,
    text: out?.text ?? '',
    fallback: out?.fallback ?? '',
  };
}

// 补全单个分支的缺省部分
export function normalizeMergeBranch(branch: MergeBranch | undefined): MergeBranch {
  return {
    join: branch?.join === 'or' ? 'or' : 'and',
    conditions: (branch?.conditions || []).map((c) => ({
      field: c.field || '',
      op: c.op || 'eq',
      value: c.value ?? '',
    })),
    output: normalizeMergeOutput(branch?.output),
  };
}

// 新建分支（UI「添加分支」用）
export function createMergeBranch(): MergeBranch {
  return normalizeMergeBranch(DEFAULT_MERGE_BRANCH);
}

// 补全规则的缺省部分（读取旧配置 / 新建规则时统一走这里）。
// 旧版单分支配置会被 toBranches 迁移成多分支，存量规则行为不变。
export function normalizeMergeRule(rule: RawMergeRule | undefined): MergeRule {
  const branches = toBranches(rule).map(normalizeMergeBranch);
  return { branches: branches.length ? branches : [createMergeBranch()] };
}

const OP_SIGN: Record<MergeCondOp, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: '包含', notEmpty: '非空',
};

const BRANCH_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

// 一种输出设置的文字描述
function describeOutput(out: MergeOutput | undefined, fields: string[]): string {
  const mode = out?.mode ?? 'concat';
  if (mode === 'text') return `固定文本「${out?.text || ''}」`;
  if (mode === 'concat') return `直接拼接${out?.separator ? `（连接符「${out.separator}」）` : ''}`;
  const mantissa = out?.mantissaField || fields[0] || '尾数';
  const exponent = out?.exponentField || fields[1] || fields[0] || '指数';
  const tail = `（${mantissa} × 10 的 ${exponent} 次方）`;
  return mode === 'product' ? `数值乘积${tail}` : `科学计数法${tail}`;
}

// 一组条件的文字描述（无条件返回空串）
function describeConditions(branch: MergeBranch): string {
  const conds = (branch.conditions || []).filter((c) => c.field);
  return conds
    .map((c) => (c.op === 'notEmpty' ? `${c.field}非空` : `${c.field} ${OP_SIGN[c.op] || '='} ${c.value ?? ''}`))
    .join(branch.join === 'or' ? ' 或 ' : ' 且 ');
}

// 规则的文字描述（界面提示用，不取值）。单分支保持旧格式，多分支用 ①②③ 逐支罗列。
export function describeMergeRule(rule: RawMergeRule | MergeRule | undefined, fields: string[]): string {
  const branches = toBranches(rule);
  if (!branches.length) return '';

  const describeOne = (b: MergeBranch) => {
    const condText = describeConditions(b);
    return `${condText ? `${condText} → ` : '其他情况 → '}${describeOutput(b.output, fields)}`;
  };

  if (branches.length === 1) return describeOne(branches[0]);
  return branches.map((b, i) => `${BRANCH_MARKS[i] || `${i + 1}.`}${describeOne(b)}`).join('；');
}
