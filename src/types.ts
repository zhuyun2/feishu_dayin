// 共享类型定义

// 模板文件信息（服务端 /api/templates 返回）
export interface TemplateInfo {
  name: string; // 含 .docx 后缀
  size: number; // 字节
  mtime: number; // 毫秒时间戳
}

// 单个数据表的匹配配置
export interface TableMatchConfig {
  matchFieldId: string;
  matchFieldName: string;
  // 打印前字段校验
  checkEnabled?: boolean;        // 是否启用打印校验
  checkFieldId?: string;         // 校验字段 ID
  checkFieldName?: string;       // 校验字段名
  checkAllowedValues?: string[]; // 允许打印的字段值（如 通过/已审核）
}

// 全局匹配配置（/api/config）
export interface MatchConfig {
  tables: Record<string, TableMatchConfig>;
  // 下载文件命名规则：按数据表保存（键为 tableId），对该表下所有模板生效。
  // 独立于 tables，便于将来单独扩展；读写都必须整体回传，避免被覆盖丢失。
  downloadNames?: Record<string, DownloadNameConfig>;
  // 合并字段（复合占位符）输出规则：mergeFields[tableId][签名] = 规则
  mergeFields?: Record<string, MergeFieldConfig>;
  // 附件图片输出尺寸：attachmentImages[tableId][字段名] = { widthCm }
  attachmentImages?: AttachmentImageConfig;
  // 云文档推送后的自动化通知：cloudPush[baseId] = { webhookUrl, bodyTemplate }
  // 按「多维表格文档」独立保存（baseId = 多维表格 appToken），一个多维表格配一次即可
  cloudPush?: Record<string, CloudPushConfig>;
}

// ============ 云文档推送 · 自动化通知 ============
// 推送成功后 POST 一条 JSON 到「多维表格自动化 → 接收到 webhook 时」的地址。
// bodyTemplate 里的 {{变量}} 在发送前用真实值替换（按 JSON 字符串转义），
// 因此占位符必须写在 JSON 的字符串里，例如 "fileName": "{{fileName}}"。
export interface CloudPushConfig {
  /** 是否启用通知。默认 false（不启用）；启用但 webhookUrl 为空仍不会发送 */
  enabled?: boolean;
  webhookUrl?: string;
  bodyTemplate?: string;
}

// ============ 附件图片 ============
// 附件字段（FieldType.Attachment=17）里若含图片，占位符 {字段名} 处插入图片（按宽度等比缩放）；
// 非图片附件仍按原规则输出文件名文本。图片字节经服务端代理下载，避免浏览器跨域。

// 表格单元里的一条附件（SDK IOpenAttachment 的最小子集）
export interface RawAttachment {
  name: string;
  size: number;
  type: string; // mime，如 image/png
  token: string;
}

// 一个附件字段在本条记录下的解析结果（保持原始顺序）
export interface AttachmentFieldData {
  fieldId: string;
  items: RawAttachment[];
}

// 单个附件字段的图片尺寸设置（按字段名保存；高度等比自动）
export interface AttachSizeConfig {
  widthCm: number;
}

// 某张表的全部附件字段尺寸：{ [字段名]: AttachSizeConfig }
export type AttachmentImageConfig = Record<string, Record<string, AttachSizeConfig>>;

// 注入到 docx 的一个片段：图片（inline）或文本（非图片附件的文件名）
export type AttachImagePart =
  | { kind: 'image'; base64: string; ext: 'png' | 'jpg'; w: number; h: number }
  | { kind: 'text'; text: string };

// 附件图片注入绑定：字段名 → 顺序化的片段 + 该字段图片宽度
export interface AttachmentBindOptions {
  byField: Record<string, { parts: AttachImagePart[]; widthCm: number }>;
}

// ============ 下载文件命名 ============

// 命名规则可直接引用的系统变量（不依赖表格字段）
export type NameSysKey =
  | 'date'         // 当天日期 2026-09-18
  | 'time'         // 当前时间 1530
  | 'datetime'     // 2026-09-18_1530
  | 'tableName'    // 数据表名称
  | 'templateName' // 模板名称（不含扩展名）
  | 'recordId';    // 记录 ID

// 命名规则中的一个片段
export interface NamePart {
  kind: 'field' | 'text' | 'sys';
  // kind='field'：优先按 fieldId 取值；跨表复用规则时按 fieldName 兜底匹配同名字段
  fieldId?: string;
  fieldName?: string;
  // kind='text'：固定文本
  text?: string;
  // kind='sys'：系统变量
  sys?: NameSysKey;
}

// 下载文件命名规则（按表持久化到 /api/config 的 downloadNames[tableId]）
export interface DownloadNameConfig {
  enabled: boolean;   // 关闭时沿用默认命名（模板名-主字段值）
  parts: NamePart[];  // 片段顺序即拼接顺序
  join: string;       // 片段之间的连接符，默认 '-'
}

// 字段元信息（对 SDK IFieldMeta 的最小约束，含 link 字段的 property.tableId）
export interface FieldMetaLite {
  id: string;
  type: number;
  name: string;
  isPrimary?: boolean;
  property?: {
    tableId?: string; // SingleLink/DuplexLink 的关联子表 ID
    multiple?: boolean;
    [k: string]: unknown;
  } | null;
}

// 关联字段展开后的一条子记录：{ 序号: 1, 子字段名: '值', ... }
// 子表内被模板用作循环的关联字段，其值为下一层子记录数组（支持两层循环）
export type LinkedRowValue = string | number | LinkedRow[];
export type LinkedRow = Record<string, LinkedRowValue>;

// docxtemplater 填充数据：普通字段为字符串，关联字段为子记录数组
export type PrintDataValue = LinkedRowValue;

// buildPrintData 的选项
export interface BuildPrintDataOptions {
  // 模板里被用作循环的字段名（形如 {#字段}，含嵌套层）。
  // 只有出现在这里的「子表内关联字段」才会被递归展开成数组（支持两层循环），
  // 其余嵌套关联字段仍按汇总文本输出，避免无谓的接口调用与行为变化。
  // 不传 = 保持旧行为（只展开一层）。
  loopFields?: string[];
}

// buildPrintData 的产物
export interface PrintDataResult {
  data: Record<string, PrintDataValue>;
  warnings: string[];
  // 含图片附件的附件字段（字段名 → 原始附件列表）。无则 undefined。
  attachments?: Record<string, AttachmentFieldData>;
}

// 模板匹配结果
export type MatchKind = 'exact' | 'contains' | 'reverse' | 'none';
export interface MatchResult {
  name: string | null; // 匹配到的模板文件名，无则 null
  kind: MatchKind;
}

// ============ 电子印章 ============

// 印章图片信息（服务端 /api/stamps 返回）
export interface StampInfo {
  name: string; // 含扩展名，如 公司公章.png
  size: number;
  mtime: number;
}

// 印章落位预设
export type StampPosition =
  | 'right-bottom'   // 右下角（默认，对应模板「盖章:」位置）
  | 'left-bottom'    // 左下角
  | 'center'         // 居中
  | 'right-top'      // 右上角
  | 'bottom-center'; // 底部居中

// 印章锚点：中心点占页面宽/高的百分比（按文字定位时由预览动态计算并持久化，
// 下载注入（docxStamp）直接复用，保证预览/打印/下载三者位置一致）
export interface StampAnchor {
  x: number; // 0-100
  y: number; // 0-100
}

// 单页盖章设置（键为页索引，0-based；多页模板按页控制盖章与锚点）
export interface StampPageSetting {
  enabled?: boolean;    // 该页是否盖章；undefined = 默认开
  anchor?: StampAnchor; // 该页锚定文字定位结果（百分比），下载注入复用
}

// 盖章配置（打印页可调，按「表 + 模板」持久化 localStorage）
export interface StampConfig {
  stamps: string[];  // 选中的印章文件名（可多选，多枚自动错开）
  position: StampPosition;
  size: number;      // 印章宽度占页面宽度百分比 5-50，默认 18
  opacity: number;   // 不透明度 0.1-1，默认 0.85
  offsetX: number;   // 水平微调（-40 ~ 40，百分比；锚定模式下为相对锚点的微调）
  offsetY: number;   // 垂直微调（-40 ~ 40，百分比；锚定模式下为相对锚点的微调）
  anchorText?: string; // 锚定文字（如"盖章"），非空时优先以该文字为中心盖章
  anchor?: StampAnchor; // 最近一次锚定文字定位结果（百分比），下载注入复用（单页/兼容兜底）
  pages?: Record<number, StampPageSetting>; // 多页模板按页控制：是否盖章 + 每页锚点
}

// ============ 合并字段（复合占位符）============
// 模板里写 {{字段A}{字段B}}：填充前由插件把整段替换为单花括号标签 {__MERGEn}，
// 并按下面这套规则算出该标签的输出值（可带条件判断与科学计数法等输出格式）。

// 条件比较符
export type MergeCondOp =
  | 'eq'        // 等于（两边都是数字时按数值比较）
  | 'ne'        // 不等于
  | 'gt'        // 大于
  | 'gte'       // 大于等于
  | 'lt'        // 小于
  | 'lte'       // 小于等于
  | 'contains'  // 包含
  | 'notEmpty'; // 非空

// 条件组合方式：and=并（全部满足）/ or=或（任一满足）
export type MergeJoin = 'and' | 'or';

// 输出方式
export type MergeOutputMode =
  | 'concat'      // 直接拼接各字段值
  | 'scientific'  // 科学计数法：尾数×10^指数（指数取指数字段）
  | 'product'     // 数值乘积：尾数 × 10 的指数次方，输出普通数字
  | 'text';       // 固定文本：不取字段值，直接输出 output.text（如 <10、未检出）

// 单条条件
export interface MergeCondition {
  field: string; // 条件字段名（表字段，可与复合占位符内的字段不同）
  op: MergeCondOp;
  value?: string; // 比较值；notEmpty 忽略
}

// 输出设置
export interface MergeOutput {
  mode: MergeOutputMode;
  separator?: string;         // concat：字段之间的连接符，默认空（紧密拼接）
  mantissaField?: string;     // scientific / product：尾数字段，默认取占位符第 1 个字段
  exponentField?: string;     // scientific / product：指数字段，默认取占位符第 2 个字段
  superscript?: boolean;      // scientific：指数用上标字符（³）而非 ^3，默认 true
  times?: string;             // scientific：底数文本，默认 '×10'
  precision?: number | null;  // 尾数保留小数位；null/undefined = 原样输出
  text?: string;              // text：固定输出文本（不取字段值）
  fallback?: string;          // scientific / product：本分支命中但算不出数值时的输出
}

// 规则里的一个分支：一组条件 + 命中后如何输出
// conditions 为空 = 无条件（常用作末尾「其他情况」兜底分支）
export interface MergeBranch {
  join: MergeJoin;
  conditions: MergeCondition[];
  output: MergeOutput;
}

// 一个合并字段的完整规则
// 多分支按数组顺序匹配：第一个条件满足的分支生效；全部不命中则输出空串。
export interface MergeRule {
  branches: MergeBranch[];
}

// 旧版（单分支）规则形态：{ join, conditions, output.fallback }
// 仅用于读取历史配置，normalizeMergeRule 会把它迁移成 branches。
export interface LegacyMergeRule {
  join?: MergeJoin;
  conditions?: MergeCondition[];
  output?: MergeOutput;
}

// 落盘 / 接口里读到的原始规则（新旧形态都可能）
export type RawMergeRule = Partial<MergeRule> & LegacyMergeRule;

// 某张表下的全部合并字段规则：键为「签名」（占位符内字段名按顺序用 | 连接）
export type MergeFieldConfig = Record<string, MergeRule>;

// 模板里检测到的一个复合占位符
export interface MergeHit {
  signature: string; // 如 细菌数量|细菌乘方
  fields: string[];  // 如 ['细菌数量','细菌乘方']
}

// 合并字段取值作用域：循环内的「外层逐级 + 当前行」合并对象；
// 不传（顶层取值）时按整条记录的数据取值。
export type MergeScope = Record<string, PrintDataValue>;

// 填充引擎使用的合并绑定：把签名解析为「生成标签 → 输出值」
// scope = 循环内当前行的取值作用域（含父级回退），不传则取顶层数据
// warn  = 取值异常提示通道（如循环内某行引用的字段为空、算不出值），由调用方收集后展示
export interface MergeBindOptions {
  resolve: (signature: string, fields: string[], scope?: MergeScope) => string;
  warn?: (message: string) => void;
}

export const MERGE_OP_LABEL: Record<MergeCondOp, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  notEmpty: '非空',
};

export const MERGE_MODE_LABEL: Record<MergeOutputMode, string> = {
  concat: '直接拼接',
  scientific: '科学计数法',
  product: '数值乘积',
  text: '固定文本',
};

// 新建分支时的默认内容
export const DEFAULT_MERGE_BRANCH: MergeBranch = {
  join: 'and',
  conditions: [],
  output: { mode: 'concat', separator: '', superscript: true, times: '×10' },
};

// 单分支默认规则（与旧版「未设置」行为一致：紧密拼接）
export const DEFAULT_MERGE_RULE: MergeRule = {
  branches: [{ ...DEFAULT_MERGE_BRANCH, output: { ...DEFAULT_MERGE_BRANCH.output } }],
};

export const DEFAULT_STAMP_CONFIG: StampConfig = {
  stamps: [],
  position: 'right-bottom',
  size: 18,
  opacity: 0.85,
  offsetX: 0,
  offsetY: 0,
};

export const STAMP_POSITION_LABEL: Record<StampPosition, string> = {
  'right-bottom': '右下角',
  'left-bottom': '左下角',
  'center': '居中',
  'right-top': '右上角',
  'bottom-center': '底部居中',
};
