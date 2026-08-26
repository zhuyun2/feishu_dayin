import { useEffect, useRef, useState } from 'react';
import { bitable, ITable } from '@lark-base-open/js-sdk';
import type { FieldMetaLite } from '../types';

export interface ActiveRecordState {
  loading: boolean;
  table: ITable | null;
  tableId: string | null;
  tableName: string;
  fieldMetas: FieldMetaLite[];
  visibleFieldIds: string[];
  recordId: string | null;
  primaryText: string; // 当前记录主字段的显示值
  error: string | null;
}

const EMPTY: ActiveRecordState = {
  loading: true,
  table: null,
  tableId: null,
  tableName: '',
  fieldMetas: [],
  visibleFieldIds: [],
  recordId: null,
  primaryText: '',
  error: null,
};

// 封装当前激活表 + 选中记录，并订阅选择变化。
// 切表时就地重载字段与记录（不再整页 reload）。

// 获取视图可见字段列表
async function getVisibleFieldIds(table: any): Promise<string[]> {
  try {
    const view = await table.getActiveView();
    const ids = await view.getVisibleFieldIdList();
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch (e) {
    return []; // 取不到视图 → 空，上层视为全可见
  }
}

export function useActiveRecord(): ActiveRecordState {
  const [state, setState] = useState<ActiveRecordState>(EMPTY);
  const tableIdRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;

    // 加载指定表的元信息（切表或首次）
    async function loadTable(tableId: string) {
      const table = await bitable.base.getTableById(tableId);
      const [tableName, fieldMetas, visibleFieldIds] = await Promise.all([
        table.getName(),
        table.getFieldMetaList() as unknown as Promise<FieldMetaLite[]>,
        getVisibleFieldIds(table),
      ]);
      if (disposed) return;
      tableIdRef.current = tableId;
      setState((s) => ({
        ...s,
        loading: false,
        table,
        tableId,
        tableName,
        fieldMetas,
        visibleFieldIds,
        error: null,
      }));
    }

    // 更新选中记录及其主字段显示值
    async function loadRecord(table: ITable, fieldMetas: FieldMetaLite[], recordId: string | null) {
      let primaryText = '';
      if (recordId) {
        const primary = fieldMetas.find((f) => f.isPrimary) || fieldMetas[0];
        if (primary) {
          try {
            primaryText = await table.getCellString(primary.id, recordId);
          } catch (e) {
            primaryText = '';
          }
        }
      }
      if (disposed) return;
      setState((s) => ({ ...s, recordId, primaryText }));
    }

    async function handleSelection(sel: { tableId: string | null; recordId: string | null }) {
      try {
        if (!sel.tableId) return;
        // 切表：重载表元信息
        if (sel.tableId !== tableIdRef.current) {
          await loadTable(sel.tableId);
        }
        const table = await bitable.base.getTableById(sel.tableId);
        const metas = (await table.getFieldMetaList()) as unknown as FieldMetaLite[];
        await loadRecord(table, metas, sel.recordId);
      } catch (e: any) {
        if (!disposed) setState((s) => ({ ...s, loading: false, error: e?.message || String(e) }));
      }
    }

    async function init() {
      try {
        const selection = await bitable.base.getSelection();
        const tableId = selection.tableId || (await bitable.base.getActiveTable()).id;
        await loadTable(tableId);
        const table = await bitable.base.getTableById(tableId);
        const metas = (await table.getFieldMetaList()) as unknown as FieldMetaLite[];
        await loadRecord(table, metas, selection.recordId);
      } catch (e: any) {
        if (!disposed) setState((s) => ({ ...s, loading: false, error: e?.message || String(e) }));
      }
    }

    init();

    // 兜底：若 8 秒内 SDK 桥未就绪（如未在飞书内打开），停掉 loading 并提示，
    // 让模板管理/变量参考等不依赖记录的功能仍可用。
    const timer = setTimeout(() => {
      if (disposed) return;
      setState((s) =>
        s.loading
          ? { ...s, loading: false, error: '未连接到多维表格（请在飞书多维表格内以插件方式打开）' }
          : s
      );
    }, 8000);

    off = bitable.base.onSelectionChange((e) => {
      const data = (e && (e as any).data) || e;
      handleSelection({ tableId: data?.tableId ?? null, recordId: data?.recordId ?? null });
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (off) off();
    };
  }, []);

  return state;
}
