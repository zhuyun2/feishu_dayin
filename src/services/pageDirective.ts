// 模板分页指令 @@PAGE 的解析（docx / xlsx 共用）。
//
// 写法（放在模板任意位置，渲染时会被自动剔除，不打印）：
//   @@PAGE field=产品明细 size=5 sum=数量:合计数量,金额:合计金额 @@
//   - field：作为循环明细的字段名（其值应为数组）
//   - size ：每页（每张单据）的明细行数上限，默认 DEFAULT_PAGE_SIZE
//   - sum  ：需自动求和的列，col:out 形式，多个用逗号分隔

export interface PageSumRule {
  col: string;
  out: string;
}

export interface PageRule {
  field: string;
  size: number;
  sums: PageSumRule[];
}

// 未写 size 时的每页明细行数（保持既有行为）
export const DEFAULT_PAGE_SIZE = 5;

// 从一段纯文本解析分页指令；找不到或非法返回 null
export function parsePageDirective(text: string): PageRule | null {
  const m = text.match(/@@PAGE\s+([\s\S]*?)\s*@@/);
  if (!m) return null;
  const body = m[1].trim();
  const rule: Record<string, string> = {};
  body.split(/\s+/).forEach((tok) => {
    const eq = tok.indexOf('=');
    if (eq > 0) rule[tok.slice(0, eq)] = tok.slice(eq + 1);
  });
  if (!rule.field) return null;
  const size = parseInt(rule.size, 10);
  const sums: PageSumRule[] = (rule.sum ? rule.sum.split(',') : [])
    .map((s) => {
      const [col, out] = s.split(':');
      return col ? { col, out: out || `合计${col}` } : null;
    })
    .filter((x): x is PageSumRule => !!x);
  return { field: rule.field, size: Number.isFinite(size) && size > 0 ? size : DEFAULT_PAGE_SIZE, sums };
}
