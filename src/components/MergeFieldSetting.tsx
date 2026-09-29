import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Input, InputNumber, Modal, Segmented, Select, Switch, Tag, Typography, message,
} from 'antd';
import { DeleteOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';

import type {
  MergeHit, MergeRule, MergeCondition, MergeCondOp, MergeJoin, MergeOutputMode,
  MatchConfig, FieldMetaLite,
} from '../types';
import { DEFAULT_MERGE_RULE, MERGE_MODE_LABEL, MERGE_OP_LABEL } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { putConfig } from '../services/templateApi';
import {
  buildMergeValue, describeMergeRule, evaluateConditions, normalizeMergeRule,
} from '../services/mergeField';

const { Text } = Typography;

const OP_OPTIONS = (Object.keys(MERGE_OP_LABEL) as MergeCondOp[])
  .map((op) => ({ label: MERGE_OP_LABEL[op], value: op }));

const MODE_OPTIONS = (Object.keys(MERGE_MODE_LABEL) as MergeOutputMode[])
  .map((mode) => ({ label: MERGE_MODE_LABEL[mode], value: mode }));

// 占位符源码文本，如 {{细菌数量}{细菌乘方}}
// 结构 = 外层一对花括号，包住若干个普通 {字段} 占位符
export function mergePlaceholderText(fields: string[]): string {
  return `{${fields.map((f) => `{${f}}`).join('')}}`;
}

// ============ 规则编辑器（受控，可直接嵌页或放进弹窗） ============

interface EditorProps {
  fields: string[];             // 复合占位符内的字段（顺序固定）
  fieldMetas: FieldMetaLite[];  // 本表全部字段（条件字段可任选）
  value: MergeRule;
  onChange: (v: MergeRule) => void;
  previewValue: string;
  previewSatisfied: boolean;
  previewLoading: boolean;
  previewReady: boolean;        // 有记录，可给出真实预览
}

export function MergeFieldEditor({
  fields, fieldMetas, value, onChange,
  previewValue, previewSatisfied, previewLoading, previewReady,
}: EditorProps) {
  const update = (patch: Partial<MergeRule>) => onChange({ ...value, ...patch });
  const updateOutput = (patch: Partial<MergeRule['output']>) =>
    onChange({ ...value, output: { ...value.output, ...patch } });

  // 字段下拉：占位符内的字段置顶，便于快速选择
  const fieldOptions = useMemo(() => {
    const inPlaceholder = fields.map((f) => ({ label: `${f}（占位符内）`, value: f }));
    const rest = fieldMetas
      .filter((m) => fields.indexOf(m.name) === -1)
      .map((m) => ({ label: m.name, value: m.name }));
    return [...inPlaceholder, ...rest];
  }, [fields, fieldMetas]);

  const conditions = value.conditions || [];
  const isScientific = value.output.mode === 'scientific' || value.output.mode === 'product';

  const addCondition = () => {
    const fresh: MergeCondition = { field: fields[0] || '', op: 'gt', value: '' };
    update({ conditions: [...conditions, fresh] });
  };
  const setCondition = (i: number, patch: Partial<MergeCondition>) => {
    update({ conditions: conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  };
  const removeCondition = (i: number) => {
    update({ conditions: conditions.filter((_, idx) => idx !== i) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 占位符 */}
      <div style={{ background: '#f5f6f7', borderRadius: 8, padding: '8px 10px' }}>
        <div style={{ fontSize: 11, color: '#646a73', marginBottom: 2 }}>模板中的占位符</div>
        <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: '#1f2329', wordBreak: 'break-all' }}>
          {mergePlaceholderText(fields)}
        </div>
      </div>

      {/* 输出方式 */}
      <div>
        <div style={{ fontSize: 12, color: '#646a73', marginBottom: 6 }}>输出方式</div>
        <Segmented
          size="small"
          block
          value={value.output.mode}
          onChange={(v) => updateOutput({ mode: v as MergeOutputMode })}
          options={MODE_OPTIONS}
        />
      </div>

      {value.output.mode === 'concat' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#646a73', width: 62, flexShrink: 0 }}>连接符</span>
          <Input
            size="small"
            style={{ flex: 1 }}
            placeholder="留空则紧密拼接，如 2.23"
            value={value.output.separator ?? ''}
            onChange={(e) => updateOutput({ separator: e.target.value })}
          />
        </div>
      )}

      {isScientific && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#646a73', width: 62, flexShrink: 0 }}>尾数</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder="选择尾数字段"
              showSearch
              optionFilterProp="label"
              value={value.output.mantissaField || fields[0] || undefined}
              onChange={(v) => updateOutput({ mantissaField: v })}
              options={fieldOptions}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#646a73', width: 62, flexShrink: 0 }}>指数</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder="选择指数字段（10 的次方）"
              showSearch
              optionFilterProp="label"
              value={value.output.exponentField || fields[1] || fields[0] || undefined}
              onChange={(v) => updateOutput({ exponentField: v })}
              options={fieldOptions}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#646a73', width: 62, flexShrink: 0 }}>尾数小数位</span>
            <InputNumber
              size="small"
              style={{ width: 110 }}
              min={0}
              max={6}
              placeholder="原样"
              value={value.output.precision ?? undefined}
              onChange={(v) => updateOutput({ precision: typeof v === 'number' ? v : null })}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>留空 = 保持字段原值</Text>
          </div>
          {value.output.mode === 'scientific' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 62, flexShrink: 0 }}>底数文本</span>
                <Input
                  size="small"
                  style={{ width: 110 }}
                  value={value.output.times ?? '×10'}
                  onChange={(e) => updateOutput({ times: e.target.value })}
                />
                <span style={{ fontSize: 12, color: '#646a73' }}>指数用上标</span>
                <Switch
                  size="small"
                  checked={value.output.superscript !== false}
                  onChange={(v) => updateOutput({ superscript: v })}
                />
              </div>
              <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.6, marginTop: -6 }}>
                上标开：2.2×10³；上标关：2.2×10^3。个别字体缺上标字形时可关掉。
              </Text>
            </>
          )}
          <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.6, marginTop: -6 }}>
            例：尾数取「{fields[0] || '细菌数量'}」=2.2、指数取「{fields[1] || '细菌乘方'}」=3
            → 输出 2.2×10³。
          </Text>
        </>
      )}

      {/* 输出条件 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#646a73' }}>输出条件（满足才输出）</span>
          <Segmented
            size="small"
            value={value.join}
            onChange={(v) => update({ join: v as MergeJoin })}
            options={[{ label: '并（全部满足）', value: 'and' }, { label: '或（任一满足）', value: 'or' }]}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {conditions.length === 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未设置条件 = 无条件输出。点下方「添加条件」可限制输出（如 细菌数量 &gt; 0 且 细菌乘方 = 3）。
            </Text>
          )}
          {conditions.map((c, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: '#fafbfc', border: '1px solid #e5e6eb', borderRadius: 8, padding: '6px 8px',
              }}
            >
              <Select
                size="small"
                style={{ flex: 1, minWidth: 70 }}
                placeholder="字段"
                showSearch
                optionFilterProp="label"
                value={c.field || undefined}
                onChange={(v) => setCondition(i, { field: v })}
                options={fieldOptions}
              />
              <Select
                size="small"
                style={{ width: 92, flexShrink: 0 }}
                value={c.op}
                onChange={(v) => setCondition(i, { op: v as MergeCondOp })}
                options={OP_OPTIONS}
              />
              <Input
                size="small"
                style={{ flex: 1, minWidth: 50 }}
                placeholder="值"
                disabled={c.op === 'notEmpty'}
                value={c.op === 'notEmpty' ? '' : c.value ?? ''}
                onChange={(e) => setCondition(i, { value: e.target.value })}
              />
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeCondition(i)}
              />
            </div>
          ))}
        </div>

        <Button size="small" icon={<PlusOutlined />} style={{ marginTop: 6 }} onClick={addCondition}>
          添加条件
        </Button>
      </div>

      {/* 未满足时输出 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#646a73', width: 92, flexShrink: 0 }}>条件不满足时</span>
        <Input
          size="small"
          style={{ flex: 1 }}
          placeholder="留空 = 输出空白"
          value={value.output.fallback ?? ''}
          onChange={(e) => updateOutput({ fallback: e.target.value })}
        />
      </div>

      {/* 实时预览 */}
      <div
        style={{
          background: previewReady && !previewSatisfied ? '#fff7e6' : '#e8f0ff',
          borderRadius: 8,
          padding: '8px 10px',
        }}
      >
        <div style={{ fontSize: 11, color: '#646a73', marginBottom: 2 }}>
          输出预览{previewLoading ? '（读取中…）' : ''}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2329', wordBreak: 'break-all' }}>
          {previewValue || '（空）'}
        </div>
        <div style={{ fontSize: 11, color: '#8f959e', marginTop: 4 }}>
          {!previewReady
            ? '未选中记录，预览无效；选中记录后即为真实输出。'
            : previewSatisfied
              ? '当前记录满足条件，按上方规则输出。'
              : `当前记录不满足条件，输出「${value.output.fallback || '空'}」。`}
        </div>
      </div>
    </div>
  );
}

// ============ 弹窗版 ============

interface ModalProps {
  open: boolean;
  active: ActiveRecordState;
  matchConfig: MatchConfig;
  merge: MergeHit | null;
  onClose: () => void;
  onSaved: (cfg: MatchConfig) => void;
}

export default function MergeFieldModal({
  open, active, matchConfig, merge, onClose, onSaved,
}: ModalProps) {
  const [draft, setDraft] = useState<MergeRule>(DEFAULT_MERGE_RULE);
  const [previewValue, setPreviewValue] = useState('');
  const [previewSatisfied, setPreviewSatisfied] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const gateRef = useRef(0);

  const tableId = active.tableId;
  const fields = merge?.fields || [];

  // 打开时以已保存规则初始化草稿
  useEffect(() => {
    if (!open || !merge) return;
    const saved = tableId ? matchConfig.mergeFields?.[tableId]?.[merge.signature] : undefined;
    setDraft(normalizeMergeRule(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, merge?.signature, tableId]);

  // 实时预览：读取当前记录用到的字段值后按规则算输出（防抖 + 竞态保护）
  useEffect(() => {
    if (!open || !merge) return;
    const ticket = ++gateRef.current;
    const timer = setTimeout(async () => {
      const names = new Set<string>(merge.fields);
      (draft.conditions || []).forEach((c) => { if (c.field) names.add(c.field); });
      if (draft.output.mantissaField) names.add(draft.output.mantissaField);
      if (draft.output.exponentField) names.add(draft.output.exponentField);

      const values = new Map<string, string>();
      const canRead = !!active.table && !!active.recordId;
      if (canRead) {
        setPreviewLoading(true);
        await Promise.all(Array.from(names).map(async (n) => {
          const meta = active.fieldMetas.find((f) => f.name === n);
          if (!meta) return;
          try {
            const s = await active.table!.getCellString(meta.id, active.recordId!);
            values.set(n, s == null ? '' : String(s));
          } catch (e) {
            values.set(n, '');
          }
        }));
      }
      if (ticket !== gateRef.current) return;

      const getter = (f: string) => values.get(f) ?? '';
      setPreviewLoading(false);
      setPreviewSatisfied(evaluateConditions(draft, getter));
      setPreviewValue(buildMergeValue(draft, merge.fields, getter));
    }, 300);
    return () => clearTimeout(timer);
  }, [open, merge, draft, active.table, active.recordId, active.fieldMetas]);

  const handleSave = useCallback(async () => {
    if (!tableId || !merge) { message.error('未连接到数据表，无法保存'); return; }
    setSaving(true);
    try {
      // 整体回传所有已知顶层字段，避免覆盖写丢掉其它配置
      const next: MatchConfig = {
        ...matchConfig,
        tables: { ...matchConfig.tables },
        downloadNames: { ...(matchConfig.downloadNames || {}) },
        mergeFields: { ...(matchConfig.mergeFields || {}) },
      };
      next.mergeFields![tableId] = {
        ...(next.mergeFields![tableId] || {}),
        [merge.signature]: normalizeMergeRule(draft),
      };
      const saved = await putConfig(next);
      onSaved(saved);
      message.success('已保存合并字段输出设置');
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [tableId, merge, matchConfig, draft, onSaved, onClose]);

  const restoreDefault = () => setDraft(normalizeMergeRule(undefined));

  return (
    <Modal
      open={open}
      title={merge ? `合并字段输出设置：${mergePlaceholderText(merge.fields)}` : '合并字段输出设置'}
      okText="保存"
      cancelText="取消"
      width={520}
      confirmLoading={saving}
      onOk={handleSave}
      onCancel={onClose}
    >
      {!active.recordId && active.tableId ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前未选中记录，预览为空；选中记录后即为真实输出。"
        />
      ) : null}

      <MergeFieldEditor
        fields={fields}
        fieldMetas={active.fieldMetas}
        value={draft}
        onChange={setDraft}
        previewValue={previewValue}
        previewSatisfied={previewSatisfied}
        previewLoading={previewLoading}
        previewReady={!!active.recordId && !!active.table}
      />

      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <Button size="small" type="link" icon={<SettingOutlined />} onClick={restoreDefault}>
          恢复默认（直接拼接）
        </Button>
      </div>
    </Modal>
  );
}

// 打印页「合并字段」面板里每个占位符的设置入口
export function MergeFieldRuleButton({
  rule, fields, onClick,
}: {
  rule?: MergeRule;
  fields: string[];
  onClick: () => void;
}) {
  const desc = rule ? describeMergeRule(rule, fields) : '';
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: '#fafbfc', border: '1px solid #e5e6eb', borderRadius: 8, padding: '6px 8px',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#1f2329', wordBreak: 'break-all' }}>
          {mergePlaceholderText(fields)}
        </div>
        <div style={{ fontSize: 11, color: desc ? '#3370ff' : '#ff8800', marginTop: 2 }}>
          {desc || '未设置：默认紧密拼接，点右侧「设置」配置输出与条件'}
        </div>
      </div>
      <Tag color={rule ? 'green' : 'orange'} style={{ margin: 0, flexShrink: 0 }}>
        {rule ? '已设置' : '未设置'}
      </Tag>
      <Button size="small" onClick={onClick} style={{ flexShrink: 0 }}>设置</Button>
    </div>
  );
}
