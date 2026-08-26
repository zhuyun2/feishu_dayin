import type { FieldMetaLite } from '../types';

// 按视图可见字段顺序拆分字段：visible 按 visibleFieldIds 顺序，其余为 hidden。
// visibleFieldIds 为空（取不到视图）时，全部归入 visible（原序）。
export function orderFields(
  fieldMetas: FieldMetaLite[],
  visibleFieldIds: string[]
): { visible: FieldMetaLite[]; hidden: FieldMetaLite[] } {
  if (!visibleFieldIds || visibleFieldIds.length === 0) {
    return { visible: [...fieldMetas], hidden: [] };
  }
  const byId = new Map(fieldMetas.map((f) => [f.id, f]));
  const visible: FieldMetaLite[] = [];
  for (const id of visibleFieldIds) {
    const m = byId.get(id);
    if (m) visible.push(m);
  }
  const visibleSet = new Set(visibleFieldIds);
  const hidden = fieldMetas.filter((f) => !visibleSet.has(f.id));
  return { visible, hidden };
}
