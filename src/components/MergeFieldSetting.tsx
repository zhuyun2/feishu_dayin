import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Input, InputNumber, Modal, Segmented, Select, Switch, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined, SettingOutlined,
} from '@ant-design/icons';

import type {
  MergeHit, MergeRule, MergeBranch, MergeCondition, MergeCondOp, MergeJoin, MergeOutputMode,
  MatchConfig, FieldMetaLite,
} from '../types';
import { MERGE_MODE_LABEL, MERGE_OP_LABEL } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { putConfig } from '../services/templateApi';
import {
  buildMergeValue, createMergeBranch, describeMergeRule, evaluateConditions, normalizeMergeRule,
} from '../services/mergeField';

const { Text } = Typography;

const OP_OPTIONS = (Object.keys(MERGE_OP_LABEL) as MergeCondOp[])
  .map((op) => ({ label: MERGE_OP_LABEL[op], value: op }));

const MODE_OPTIONS = (Object.keys(MERGE_MODE_LABEL) as MergeOutputMode[])
  .map((mode) => ({ label: MERGE_MODE_LABEL[mode], value: mode }));

const JOIN_OPTIONS: { label: string; value: MergeJoin }[] = [
  { label: '并（全部满足）', value: 'and' },
  { label: '或（任一满足）', value: 'or' },
];

const LABEL_STYLE: React.CSSProperties = { fontSize: 12, color: '#646a73' };

// 占位符源码文本，如 {{细菌数量}{细菌乘方}}
// 结构 = 外层一对花括号，包住若干个普通 {字段} 占位符
export function mergePlaceholderText(fields: string[]): string {
  return `{${fields.map((f) => `{${f}}`).join('')}}`;
}

// ============ 单个分支的输出设置 ============

function BranchOutputEditor({
  fields, fieldOptions, output, onChange,
}: {
  fields: string[];
  fieldOptions: { label: string; value: string }[];
  output: MergeBranch['output'];
  onChange: (patch: Partial<MergeBranch['output']>) => void;
}) {
  const isScientific = output.mode === 'scientific' || output.mode === 'product';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>输出方式</div>
        <Segmented
          size="small"
          block
          value={output.mode}
          onChange={(v) => onChange({ mode: v as MergeOutputMode })}
          options={MODE_OPTIONS}
        />
      </div>

      {output.mode === 'text' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>固定内容</span>
          <Input
            size="small"
            style={{ flex: 1 }}
            placeholder="如 <10、未检出、/"
            value={output.text ?? ''}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </div>
      )}

      {output.mode === 'concat' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>连接符</span>
          <Input
            size="small"
            style={{ flex: 1 }}
            placeholder="留空则紧密拼接，如 2.23"
            value={output.separator ?? ''}
            onChange={(e) => onChange({ separator: e.target.value })}
          />
        </div>
      )}

      {isScientific && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>尾数</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder="选择尾数字段"
              showSearch
              optionFilterProp="label"
              value={output.mantissaField || fields[0] || undefined}
              onChange={(v) => onChange({ mantissaField: v })}
              options={fieldOptions}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>指数</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder="选择指数字段（10 的次方）"
              showSearch
              optionFilterProp="label"
              value={output.exponentField || fields[1] || fields[0] || undefined}
              onChange={(v) => onChange({ exponentField: v })}
              options={fieldOptions}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>尾数小数位</span>
            <InputNumber
              size="small"
              style={{ width: 110 }}
              min={0}
              max={6}
              placeholder="原样"
              value={output.precision ?? undefined}
              onChange={(v) => onChange({ precision: typeof v === 'number' ? v : null })}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>留空 = 保持字段原值</Text>
          </div>
          {output.mode === 'scientific' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...LABEL_STYLE, width: 62, flexShrink: 0 }}>底数文本</span>
              <Input
                size="small"
                style={{ width: 110 }}
                value={output.times ?? '×10'}
                onChange={(e) => onChange({ times: e.target.value })}
              />
              <span style={LABEL_STYLE}>指数用上标</span>
              <Switch
                size="small"
                checked={output.superscript !== false}
                onChange={(v) => onChange({ superscript: v })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============ 单个分支卡片 ============

function MergeBranchCard({
  index, total, fields, fieldOptions, branch, matched, onChange, onRemove, onMove,
}: {
  index: number;
  total: number;
  fields: string[];
  fieldOptions: { label: string; value: string }[];
  branch: MergeBranch;
  matched: boolean;
  onChange: (patch: Partial<MergeBranch>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const conditions = branch.conditions || [];
  const isCatchAll = conditions.length === 0;

  const setCondition = (i: number, patch: Partial<MergeCondition>) => {
    onChange({ conditions: conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  };
  const addCondition = () => {
    onChange({ conditions: [...conditions, { field: fields[0] || '', op: 'gt', value: '' }] });
  };
  const removeCondition = (i: number) => {
    onChange({ conditions: conditions.filter((_, idx) => idx !== i) });
  };
  const updateOutput = (patch: Partial<MergeBranch['output']>) =>
    onChange({ output: { ...branch.output, ...patch } });

  // 无条件分支放在中间会让后面的分支永远不生效
  const shadowedNotice = isCatchAll && index < total - 1;

  return (
    <div
      style={{
        border: `1px solid ${matched ? '#52c41a' : '#e5e6eb'}`,
        background: matched ? '#f6ffed' : '#fafbfc',
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#1f2329' }}>分支 {index + 1}</span>
        {isCatchAll && (
          <Tag color="blue" style={{ margin: 0 }}>其他情况（无条件）</Tag>
        )}
        {matched && (
          <Tag color="green" style={{ margin: 0 }}>当前记录命中</Tag>
        )}
        <div style={{ flex: 1 }} />
        <Tooltip title="上移（提高优先级）">
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
        </Tooltip>
        <Tooltip title="下移">
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          />
        </Tooltip>
        <Tooltip title={total <= 1 ? '至少保留一个分支' : '删除该分支'}>
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={total <= 1}
            onClick={onRemove}
          />
        </Tooltip>
      </div>

      {/* 条件 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={LABEL_STYLE}>命中条件</span>
          {conditions.length >= 2 && (
            <Segmented
              size="small"
              value={branch.join}
              onChange={(v) => onChange({ join: v as MergeJoin })}
              options={JOIN_OPTIONS}
            />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isCatchAll && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未设置条件 = 无条件输出，用于「其它情况」兜底。
            </Text>
          )}
          {conditions.map((c, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: '#fff', border: '1px solid #e5e6eb', borderRadius: 8, padding: '6px 8px',
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
        {shadowedNotice && (
          <div style={{ marginTop: 6 }}>
            <Text type="warning" style={{ fontSize: 11 }}>
              该分支无条件，排在它后面的分支永远不会生效，建议移到最下面。
            </Text>
          </div>
        )}
      </div>

      {/* 输出 */}
      <BranchOutputEditor
        fields={fields}
        fieldOptions={fieldOptions}
        output={branch.output}
        onChange={updateOutput}
      />

      {(branch.output.mode === 'scientific' || branch.output.mode === 'product') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...LABEL_STYLE, width: 92, flexShrink: 0 }}>算不出值时</span>
          <Input
            size="small"
            style={{ flex: 1 }}
            placeholder="留空 = 输出空白"
            value={branch.output.fallback ?? ''}
            onChange={(e) => updateOutput({ fallback: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

// ============ 规则编辑器（受控，可直接嵌页或放进弹窗） ============

interface EditorProps {
  fields: string[];             // 复合占位符内的字段（顺序固定）
  fieldMetas: FieldMetaLite[];  // 本表全部字段（条件字段可任选）
  value: MergeRule;
  onChange: (v: MergeRule) => void;
  previewValue: string;
  previewMatched: number;       // 命中的分支下标；-1 = 全部不命中
  previewLoading: boolean;
  previewReady: boolean;        // 有记录，可给出真实预览
}

export function MergeFieldEditor({
  fields, fieldMetas, value, onChange,
  previewValue, previewMatched, previewLoading, previewReady,
}: EditorProps) {
  const branches = value.branches || [];

  // 字段下拉：占位符内的字段置顶，便于快速选择
  const fieldOptions = useMemo(() => {
    const inPlaceholder = fields.map((f) => ({ label: `${f}（占位符内）`, value: f }));
    const rest = fieldMetas
      .filter((m) => fields.indexOf(m.name) === -1)
      .map((m) => ({ label: m.name, value: m.name }));
    return [...inPlaceholder, ...rest];
  }, [fields, fieldMetas]);

  const setBranch = (i: number, patch: Partial<MergeBranch>) => {
    onChange({ branches: branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  };
  const addBranch = () => onChange({ branches: [...branches, createMergeBranch()] });
  const removeBranch = (i: number) => {
    if (branches.length <= 1) return;
    onChange({ branches: branches.filter((_, idx) => idx !== i) });
  };
  const moveBranch = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= branches.length) return;
    const next = branches.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ branches: next });
  };

  const previewText = !previewReady
    ? '未选中记录，预览无效；选中记录后即为真实输出。'
    : previewMatched >= 0
      ? `当前记录命中分支 ${previewMatched + 1}，按该分支输出。`
      : '当前记录不满足任何分支的条件，输出空白。';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 占位符 */}
      <div style={{ background: '#f5f6f7', borderRadius: 8, padding: '8px 10px' }}>
        <div style={{ fontSize: 11, color: '#646a73', marginBottom: 2 }}>模板中的占位符</div>
        <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: '#1f2329', wordBreak: 'break-all' }}>
          {mergePlaceholderText(fields)}
        </div>
      </div>

      {/* 分支列表 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#1f2329' }}>输出分支</span>
          <Text type="secondary" style={{ fontSize: 11 }}>
            从上往下匹配，第一个条件满足的分支生效
          </Text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {branches.map((b, i) => (
            <MergeBranchCard
              key={i}
              index={i}
              total={branches.length}
              fields={fields}
              fieldOptions={fieldOptions}
              branch={b}
              matched={previewReady && previewMatched === i}
              onChange={(patch) => setBranch(i, patch)}
              onRemove={() => removeBranch(i)}
              onMove={(delta) => moveBranch(i, delta)}
            />
          ))}
        </div>
        <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ marginTop: 8 }} block onClick={addBranch}>
          添加分支
        </Button>
      </div>

      {/* 实时预览 */}
      <div
        style={{
          background: previewReady && previewMatched < 0 ? '#fff7e6' : '#e8f0ff',
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
        <div style={{ fontSize: 11, color: '#8f959e', marginTop: 4 }}>{previewText}</div>
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
  const [draft, setDraft] = useState<MergeRule>(() => normalizeMergeRule(undefined));
  const [previewValue, setPreviewValue] = useState('');
  const [previewMatched, setPreviewMatched] = useState(-1);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const gateRef = useRef(0);

  const tableId = active.tableId;
  const fields = merge?.fields || [];

  // 打开时以已保存规则初始化草稿（旧版单分支配置会自动迁移）
  useEffect(() => {
    if (!open || !merge) return;
    const saved = tableId ? matchConfig.mergeFields?.[tableId]?.[merge.signature] : undefined;
    setDraft(normalizeMergeRule(saved as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, merge?.signature, tableId]);

  // 实时预览：读取当前记录用到的字段值后按规则算输出（防抖 + 竞态保护）
  useEffect(() => {
    if (!open || !merge) return;
    const ticket = ++gateRef.current;
    const timer = setTimeout(async () => {
      const names = new Set<string>(merge.fields);
      (draft.branches || []).forEach((b) => {
        (b.conditions || []).forEach((c) => { if (c.field) names.add(c.field); });
        if (b.output.mantissaField) names.add(b.output.mantissaField);
        if (b.output.exponentField) names.add(b.output.exponentField);
      });

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
      const branches = draft.branches || [];
      let matched = -1;
      for (let i = 0; i < branches.length; i++) {
        if (evaluateConditions(branches[i], getter)) { matched = i; break; }
      }
      setPreviewLoading(false);
      setPreviewMatched(matched);
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
      width={560}
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
        previewMatched={previewMatched}
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
  const desc = rule ? describeMergeRule(rule as any, fields) : '';
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
        <div style={{ fontSize: 11, color: desc ? '#3370ff' : '#ff8800', marginTop: 2, lineHeight: 1.5 }}>
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
