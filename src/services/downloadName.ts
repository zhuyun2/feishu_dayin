import type {
  DownloadNameConfig, FieldMetaLite, NamePart, NameSysKey,
} from '../types';

// ============ 下载文件命名 ============
// 需求：把「下载」保存的文件名改成按记录字段拼接（如 合同-A001-客户名）。
// 规则按数据表保存、对该表下所有模板生效 —— 设置一次，之后每个模板下载都自动套用。
//
// 设计要点：
// - 规则存为「片段数组 + 连接符」，而非字符串模板，读写无需解析、不易写坏；
// - 片段值为空时自动跳过，避免出现 "合同--2026" 这类空档；
// - 字段优先按 fieldId 取值，fieldId 不在当前表时按 fieldName 兜底（跨表复用同名字段）；
// - 文件名统一走 Windows 非法字符清洗与长度截断，防止 saveAs 静默失败。

export const NAME_SYS_LABEL: Record<NameSysKey, string> = {
  date: '当天日期',
  time: '当前时间',
  datetime: '日期时间',
  tableName: '数据表名称',
  templateName: '模板名称',
  recordId: '记录ID',
};

export const NAME_SYS_KEYS: NameSysKey[] = ['date', 'time', 'datetime', 'tableName', 'templateName', 'recordId'];

export const DEFAULT_DOWNLOAD_NAME_CONFIG: DownloadNameConfig = {
  enabled: false,
  parts: [],
  join: '-',
};

export const NAME_JOIN_OPTIONS: { label: string; value: string }[] = [
  { label: '-', value: '-' },
  { label: '_', value: '_' },
  { label: '空格', value: ' ' },
  { label: '无', value: '' },
];

const MAX_NAME_LEN = 120;

// ============ 纯逻辑（无 SDK 依赖，可直接单测） ============

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// 系统变量取值
export function resolveSysVar(key: NameSysKey, ctx: NameBuildContext): string {
  const now = ctx.now;
  switch (key) {
    case 'date':
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    case 'time':
      return `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    case 'datetime':
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    case 'tableName':
      return ctx.tableName || '';
    case 'templateName':
      return (ctx.templateName || '').replace(/\.(docx|xlsx)$/i, '');
    case 'recordId':
      return ctx.recordId || '';
    default:
      return '';
  }
}

export interface NameBuildContext {
  now: Date;
  tableName: string;
  templateName: string; // 含扩展名
  recordId: string;
  // 同步取字段片段的值（异步读取由 buildDownloadName 预取后注入）
  getFieldValue: (part: NamePart) => string;
}

// 按规则拼装文件名（不含扩展名，尚未清洗）
export function composeName(cfg: DownloadNameConfig, ctx: NameBuildContext): string {
  const join = typeof cfg.join === 'string' ? cfg.join : '-';
  const segs: string[] = [];
  for (const p of cfg.parts || []) {
    let v = '';
    if (p.kind === 'text') v = (p.text || '').trim();
    else if (p.kind === 'sys') v = p.sys ? resolveSysVar(p.sys, ctx).trim() : '';
    else v = (ctx.getFieldValue(p) || '').trim();
    if (!v) continue; // 空片段跳过，避免连续连接符
    segs.push(v);
  }
  return segs.join(join);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// 文件名清洗：返回可用于 saveAs 的安全名（不含扩展名）
export function sanitizeFileName(raw: string, fallback = '打印'): string {
  let s = (raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_') // Windows 非法字符（含路径分隔符）
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN).replace(/[\s.]+$/, '');
  if (!s) s = fallback;
  if (WIN_RESERVED.test(s)) s = `${s}_`; // 规避 Windows 保留设备名
  return s;
}

// 规则的文字描述（同步，用于界面提示，不取值）
export function describeNameConfig(cfg: DownloadNameConfig | undefined): string {
  if (!cfg || !cfg.enabled || !cfg.parts || cfg.parts.length === 0) return '';
  const join = typeof cfg.join === 'string' ? cfg.join : '-';
  const segs = cfg.parts.map((p) => {
    if (p.kind === 'text') return p.text ? `「${p.text}」` : '';
    if (p.kind === 'sys') return `{${p.sys ? NAME_SYS_LABEL[p.sys] : '系统变量'}}`;
    return `{${p.fieldName || '字段'}}`;
  }).filter(Boolean);
  if (!segs.length) return '';
  return segs.join(join);
}

// 默认命名（未启用规则 / 规则产出为空时的回退）：模板名-主字段值
export function defaultBaseName(templateName: string, primaryText?: string): string {
  const base = (templateName || '').replace(/\.(docx|xlsx)$/i, '') || '打印';
  const suffix = primaryText ? `-${primaryText}` : '';
  return sanitizeFileName(`${base}${suffix}`, '打印');
}

// ============ 取值（依赖多维表 SDK，故 table 为 any） ============

// 读取单元格显示字符串；失败返回空串（命名失败不应阻断下载）
async function readCell(table: any, fieldId: string, recordId: string): Promise<string> {
  if (!table || !fieldId || !recordId) return '';
  try {
    const s = await table.getCellString(fieldId, recordId);
    return s == null ? '' : String(s);
  } catch (e) {
    return '';
  }
}

// 字段片段 → 当前表的字段元信息：先按 id，再按同名兜底
export function resolveFieldMeta(part: NamePart, fieldMetas: FieldMetaLite[]): FieldMetaLite | undefined {
  if (part.fieldId) {
    const byId = fieldMetas.find((f) => f.id === part.fieldId);
    if (byId) return byId;
  }
  if (part.fieldName) {
    return fieldMetas.find((f) => f.name === part.fieldName);
  }
  return undefined;
}

function partKey(p: NamePart): string {
  return p.kind === 'field' ? `f:${p.fieldId || ''}|${p.fieldName || ''}` : '';
}

export interface BuildDownloadNameInput {
  config?: DownloadNameConfig;
  table: any;
  fieldMetas: FieldMetaLite[];
  tableName: string;
  recordId: string | null;
  templateName: string;  // 含扩展名
  primaryText?: string;  // 回退命名用的主字段值
  now?: Date;
}

// 生成下载文件名（不含扩展名）。未启用规则、读出为空、或取值异常时回退默认命名。
export async function buildDownloadName(input: BuildDownloadNameInput): Promise<string> {
  const fallback = defaultBaseName(input.templateName, input.primaryText);
  const cfg = input.config;
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.parts) || cfg.parts.length === 0) return fallback;

  const fieldParts = cfg.parts.filter((p) => p.kind === 'field');
  const values = new Map<string, string>();
  await Promise.all(
    fieldParts.map(async (p) => {
      const meta = resolveFieldMeta(p, input.fieldMetas);
      if (!meta) return;
      const v = await readCell(input.table, meta.id, input.recordId || '');
      values.set(partKey(p), v);
    })
  );

  const ctx: NameBuildContext = {
    now: input.now || new Date(),
    tableName: input.tableName,
    templateName: input.templateName,
    recordId: input.recordId || '',
    getFieldValue: (p) => values.get(partKey(p)) || '',
  };

  const raw = composeName(cfg, ctx);
  // 规则产出为空（字段全空等）→ 回退默认命名，保证不出现 "打印.docx" 之外的意外
  return sanitizeFileName(raw, fallback);
}
