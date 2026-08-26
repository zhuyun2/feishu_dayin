import type { TemplateInfo, MatchResult } from '../types';

// 去掉 Office 模板后缀
function baseName(name: string): string {
  return name.replace(/\.(docx|xlsx)$/i, '');
}

// 根据匹配字段的值，在模板列表中挑选最合适的模板。
// 规则优先级：① 精确相等 → ② 模板名包含值（取最短）→ ③ 值包含模板名（取最长）→ ④ 无匹配。
export function matchTemplate(value: string, templates: TemplateInfo[]): MatchResult {
  const v = (value || '').trim();
  if (!v || templates.length === 0) return { name: null, kind: 'none' };

  const bases = templates.map((t) => ({ name: t.name, base: baseName(t.name) }));

  // ① 精确相等（多个则按名称排序取首个）
  const exact = bases
    .filter((b) => b.base === v)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (exact.length > 0) return { name: exact[0].name, kind: 'exact' };

  // ② 模板名包含值：取 base 最短者（最贴近）
  const contains = bases
    .filter((b) => b.base.includes(v))
    .sort((a, b) => a.base.length - b.base.length || a.name.localeCompare(b.name, 'zh-CN'));
  if (contains.length > 0) return { name: contains[0].name, kind: 'contains' };

  // ③ 值包含模板名：取 base 最长者（信息量最大）
  const reverse = bases
    .filter((b) => b.base.length > 0 && v.includes(b.base))
    .sort((a, b) => b.base.length - a.base.length || a.name.localeCompare(b.name, 'zh-CN'));
  if (reverse.length > 0) return { name: reverse[0].name, kind: 'reverse' };

  return { name: null, kind: 'none' };
}

// 自动匹配的选中状态始终以本次结果为准；无匹配时返回 null 以清掉旧模板。
export function resolveAutoSelection(value: string, templates: TemplateInfo[]): MatchResult {
  return matchTemplate(value, templates);
}
