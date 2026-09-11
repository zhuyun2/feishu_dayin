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
export type LinkedRow = Record<string, string | number>;

// docxtemplater 填充数据：普通字段为字符串，关联字段为子记录数组
export type PrintDataValue = string | number | LinkedRow[];

// buildPrintData 的产物
export interface PrintDataResult {
  data: Record<string, PrintDataValue>;
  warnings: string[];
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
