import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Input, Modal, Segmented, Select, Switch, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined, SettingOutlined,
} from '@ant-design/icons';

import type { DownloadNameConfig, FieldMetaLite, MatchConfig, NamePart, NameSysKey } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { putConfig } from '../services/templateApi';
import {
  DEFAULT_DOWNLOAD_NAME_CONFIG, NAME_JOIN_OPTIONS, NAME_SYS_KEYS, NAME_SYS_LABEL,
  buildDownloadName, describeNameConfig,
} from '../services/downloadName';

const { Text } = Typography;

// ============ 命名规则编辑器（受控组件，可直接嵌页或放进弹窗） ============

interface EditorProps {
  fieldMetas: FieldMetaLite[];
  value: DownloadNameConfig;
  onChange: (v: DownloadNameConfig) => void;
  previewName: string;   // 不含扩展名
  previewExt: string;    // .docx / .xlsx
  previewHint?: string;  // 预览不可用时（无记录等）的说明
}

const KIND_TAG: Record<NamePart['kind'], { label: string; color: string }> = {
  field: { label: '字段', color: 'blue' },
  text: { label: '文本', color: 'default' },
  sys: { label: '系统', color: 'purple' },
};

export function DownloadNameEditor({
  fieldMetas, value, onChange, previewName, previewExt, previewHint,
}: EditorProps) {
  const fieldOptions = useMemo(
    () => fieldMetas.map((f) => ({ label: f.name, value: f.id })),
    [fieldMetas]
  );

  const update = (patch: Partial<DownloadNameConfig>) => onChange({ ...value, ...patch });
  const parts = value.parts || [];

  const setPart = (i: number, patch: Partial<NamePart>) => {
    update({ parts: parts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  };
  const removePart = (i: number) => update({ parts: parts.filter((_, idx) => idx !== i) });
  const movePart = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= parts.length) return;
    const next = parts.slice();
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
    update({ parts: next });
  };
  const addPart = (kind: NamePart['kind']) => {
    const fresh: NamePart =
      kind === 'text' ? { kind: 'text', text: '' }
        : kind === 'sys' ? { kind: 'sys', sys: 'date' }
          : { kind: 'field' };
    update({ parts: [...parts, fresh] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Switch checked={value.enabled} onChange={(v) => update({ enabled: v })} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>启用自定义命名</span>
        {value.enabled && <Tag color="green" style={{ margin: 0 }}>已开启</Tag>}
      </div>

      <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
        设置一次，<strong>本数据表下所有模板</strong>点「下载」都按此规则生成文件名；
        片段值为空时自动跳过，不会出现连续连接符。
      </Text>

      {value.enabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#646a73' }}>连接符</span>
            <Segmented
              size="small"
              value={value.join}
              onChange={(v) => update({ join: v as string })}
              options={NAME_JOIN_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
          </div>

          {/* 片段列表：顺序即拼接顺序 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {parts.length === 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                还没有片段，点下方按钮添加：字段（如 合同编号）、固定文本（如 合同）、系统变量（如 当天日期）。
              </Text>
            )}
            {parts.map((p, i) => {
              const tag = KIND_TAG[p.kind];
              const idInTable = p.fieldId ? fieldMetas.some((f) => f.id === p.fieldId) : false;
              return (
                <div
                  key={`${p.kind}-${i}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: '#fafbfc', border: '1px solid #e5e6eb',
                    borderRadius: 8, padding: '6px 8px',
                  }}
                >
                  <Tag color={tag.color} style={{ margin: 0, flexShrink: 0 }}>{tag.label}</Tag>

                  {p.kind === 'text' && (
                    <Input
                      size="small"
                      style={{ flex: 1, minWidth: 60 }}
                      placeholder="固定文本，如 合同"
                      value={p.text || ''}
                      onChange={(e) => setPart(i, { text: e.target.value })}
                    />
                  )}

                  {p.kind === 'field' && (
                    <Select
                      size="small"
                      style={{ flex: 1, minWidth: 60 }}
                      placeholder={p.fieldName ? `${p.fieldName}（本表无此字段）` : '选择字段'}
                      showSearch
                      optionFilterProp="label"
                      value={idInTable ? p.fieldId : undefined}
                      onChange={(v) => {
                        const meta = fieldMetas.find((f) => f.id === v);
                        setPart(i, { fieldId: v, fieldName: meta?.name || '' });
                      }}
                      options={fieldOptions}
                    />
                  )}

                  {p.kind === 'sys' && (
                    <Select
                      size="small"
                      style={{ flex: 1, minWidth: 60 }}
                      value={p.sys || 'date'}
                      onChange={(v) => setPart(i, { sys: v as NameSysKey })}
                      options={NAME_SYS_KEYS.map((k) => ({ label: NAME_SYS_LABEL[k], value: k }))}
                    />
                  )}

                  <Tooltip title="前移">
                    <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => movePart(i, -1)} />
                  </Tooltip>
                  <Tooltip title="后移">
                    <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === parts.length - 1} onClick={() => movePart(i, 1)} />
                  </Tooltip>
                  <Tooltip title="删除">
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removePart(i)} />
                  </Tooltip>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addPart('field')}>字段</Button>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addPart('text')}>固定文本</Button>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addPart('sys')}>系统变量</Button>
          </div>

          {/* 实时预览 */}
          <div style={{ background: '#e8f0ff', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 11, color: '#646a73', marginBottom: 2 }}>文件名预览</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2329', wordBreak: 'break-all' }}>
              {previewName}{previewExt}
            </div>
            {previewHint && (
              <div style={{ fontSize: 11, color: '#8f959e', marginTop: 4 }}>{previewHint}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============ 弹窗版（打印页 / 模板页共用） ============

interface ModalProps {
  open: boolean;
  active: ActiveRecordState;
  matchConfig: MatchConfig;
  templateName?: string | null; // 当前选中的模板，用于预览
  onClose: () => void;
  onSaved: (cfg: MatchConfig) => void;
}

export default function DownloadNameModal({
  open, active, matchConfig, templateName, onClose, onSaved,
}: ModalProps) {
  const [draft, setDraft] = useState<DownloadNameConfig>(DEFAULT_DOWNLOAD_NAME_CONFIG);
  const [previewName, setPreviewName] = useState('');
  const [previewHint, setPreviewHint] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const previewGateRef = useRef(0);

  const tableId = active.tableId;

  // 打开时以已保存配置初始化草稿
  useEffect(() => {
    if (!open) return;
    const saved = (tableId && matchConfig.downloadNames?.[tableId]) || DEFAULT_DOWNLOAD_NAME_CONFIG;
    setDraft({
      enabled: !!saved.enabled,
      parts: Array.isArray(saved.parts) ? saved.parts.map((p) => ({ ...p })) : [],
      join: typeof saved.join === 'string' ? saved.join : '-',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tableId]);

  const ext = templateName && /\.xlsx$/i.test(templateName) ? '.xlsx' : '.docx';

  // 实时预览（防抖 + 竞态保护）
  useEffect(() => {
    if (!open) return;
    const ticket = ++previewGateRef.current;
    const timer = setTimeout(async () => {
      const name = await buildDownloadName({
        config: draft,
        table: active.table,
        fieldMetas: active.fieldMetas,
        tableName: active.tableName,
        recordId: active.recordId,
        templateName: templateName || '打印.docx',
        primaryText: active.primaryText,
      });
      if (ticket !== previewGateRef.current) return;
      setPreviewName(name);
      setPreviewHint(
        !draft.enabled ? '未启用，下载时沿用默认命名（模板名-主字段值）'
          : !active.recordId ? '未选中记录，实际下载会按记录字段生成'
            : undefined
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [open, draft, active.table, active.fieldMetas, active.tableName, active.recordId, active.primaryText, templateName]);

  const handleSave = useCallback(async () => {
    if (!tableId) { message.error('未连接到数据表，无法保存'); return; }
    setSaving(true);
    try {
      const next: MatchConfig = {
        ...matchConfig,
        tables: { ...matchConfig.tables },
        downloadNames: { ...(matchConfig.downloadNames || {}) },
      };
      if (draft.enabled && draft.parts.length > 0) {
        next.downloadNames![tableId] = {
          enabled: true,
          join: draft.join,
          parts: draft.parts,
        };
      } else {
        delete next.downloadNames![tableId];
      }
      const saved = await putConfig(next);
      onSaved(saved);
      message.success(draft.enabled && draft.parts.length ? '已保存命名规则，所有模板生效' : '已关闭自定义命名');
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [tableId, matchConfig, draft, onSaved, onClose]);

  const restoreDefault = () => setDraft({
    enabled: true,
    join: '-',
    parts: [{ kind: 'sys', sys: 'date' }],
  });

  return (
    <Modal
      open={open}
      title="下载文件命名设置"
      okText="保存"
      cancelText="取消"
      width={480}
      confirmLoading={saving}
      onOk={handleSave}
      onCancel={onClose}
    >
      {!active.recordId && active.tableId ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前未选中记录，预览走默认值；保存后在选中记录下载即为真实值。"
        />
      ) : null}
      <DownloadNameEditor
        fieldMetas={active.fieldMetas}
        value={draft}
        onChange={setDraft}
        previewName={previewName}
        previewExt={ext}
        previewHint={previewHint}
      />
      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <Button size="small" type="link" onClick={restoreDefault} icon={<SettingOutlined />}>
          插入「当天日期」示例
        </Button>
      </div>
    </Modal>
  );
}

// 下载命名入口按钮（打印页操作栏 / 模板页共用），带当前规则提示
export function DownloadNameEntryButton({
  config, onClick, disabled, size = 'small', style,
}: {
  config?: DownloadNameConfig;
  onClick: () => void;
  disabled?: boolean;
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
}) {
  const desc = describeNameConfig(config);
  return (
    <Tooltip title={desc ? `当前命名规则：${desc}` : '设置下载文件命名规则（本表所有模板通用）'}>
      <Button size={size} style={style} onClick={onClick} disabled={disabled}>
        <SettingOutlined /> 命名
      </Button>
    </Tooltip>
  );
}
