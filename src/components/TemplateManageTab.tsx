import React, { useMemo, useState } from 'react';
import { Button, Input, Popconfirm, Modal, message, Select, Empty } from 'antd';
import { UploadOutlined, DeleteOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { TemplateInfo, MatchConfig } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { uploadTemplate, deleteTemplate, copyTemplate, putConfig, templateDownloadUrl } from '../services/templateApi';

interface Props {
  active: ActiveRecordState;
  templates: TemplateInfo[];
  matchConfig: MatchConfig;
  onTemplatesChanged: () => void;
  onConfigChanged: (cfg: MatchConfig) => void;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function TemplateManageTab({
  active, templates, matchConfig, onTemplatesChanged, onConfigChanged,
}: Props) {
  const [keyword, setKeyword] = useState('');
  const [copySource, setCopySource] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [showMatchEdit, setShowMatchEdit] = useState(false);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return templates;
    return templates.filter((t) => t.name.toLowerCase().includes(k));
  }, [templates, keyword]);

  const currentMatchFieldId = active.tableId
    ? matchConfig.tables[active.tableId]?.matchFieldId
    : undefined;

  const currentMatchFieldName = active.fieldMetas.find(
    (f) => f.id === currentMatchFieldId
  )?.name;

  const tableId = active.tableId;

  const doUpload = async (file: File, overwrite: boolean): Promise<boolean> => {
    if (!tableId) { message.error('未连接到数据表，无法上传'); return false; }
    const buf = await file.arrayBuffer();
    const res = await uploadTemplate(tableId, file.name, buf, overwrite);
    if (res.ok) {
      message.success(`已上传 ${file.name}`);
      onTemplatesChanged();
      return true;
    }
    if (res.conflict) {
      Modal.confirm({
        title: '同名模板已存在',
        content: `模板「${file.name}」已存在，是否覆盖？`,
        okText: '覆盖',
        cancelText: '取消',
        onOk: async () => {
          const r2 = await uploadTemplate(tableId, file.name, buf, true);
          if (r2.ok) {
            message.success(`已覆盖 ${file.name}`);
            onTemplatesChanged();
          } else {
            message.error(r2.error || '覆盖失败');
          }
        },
      });
      return false;
    }
    message.error(res.error || '上传失败');
    return false;
  };

  const uploadProps: UploadProps = {
    accept: '.docx,.xlsx',
    showUploadList: false,
    multiple: true,
    beforeUpload: (file) => {
      if (!tableId) {
        message.error('未连接到数据表，无法上传');
        return false; // Upload.LIST_IGNORE is not exported in all antd versions
      }
      if (!/\.(docx|xlsx)$/i.test(file.name)) {
        message.error('仅支持 .docx / .xlsx 文件');
        return false;
      }
      if (file.size > 15 * 1024 * 1024) {
        message.warning('文件较大（>15MB），上传可能较慢');
      }
      doUpload(file, false);
      return false;
    },
  };

  const handleDelete = async (name: string) => {
    if (!tableId) return;
    try {
      await deleteTemplate(tableId, name);
      message.success(`已删除 ${name}`);
      onTemplatesChanged();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const openCopy = (name: string) => {
    setCopySource(name);
    const ext = /\.xlsx$/i.test(name) ? '.xlsx' : '.docx';
    const base = name.replace(/\.(docx|xlsx)$/i, '');
    setCopyTarget(`${base} 副本${ext}`);
  };

  const handleCopy = async () => {
    if (!copySource) return;
    let target = copyTarget.trim();
    if (!target) { message.error('请输入新模板名称'); return; }
    const srcExt = /\.xlsx$/i.test(copySource) ? '.xlsx' : '.docx';
    if (!/\.(docx|xlsx)$/i.test(target)) target += srcExt;
    if (!tableId) { message.error('未连接到数据表'); return; }
    const res = await copyTemplate(tableId, copySource, target);
    if (res.ok) {
      message.success(`已复制为 ${target}`);
      setCopySource(null);
      onTemplatesChanged();
    } else if (res.conflict) {
      message.error('目标名称已存在，请换一个');
    } else {
      message.error(res.error || '复制失败');
    }
  };

  const handleSaveMatchField = async (fieldId: string | undefined) => {
    if (!active.tableId) return;
    setSavingConfig(true);
    try {
      const next: MatchConfig = { tables: { ...matchConfig.tables } };
      if (!fieldId) {
        delete next.tables[active.tableId];
      } else {
        const meta = active.fieldMetas.find((f) => f.id === fieldId);
        next.tables[active.tableId] = {
          matchFieldId: fieldId,
          matchFieldName: meta?.name || '',
        };
      }
      const saved = await putConfig(next);
      onConfigChanged(saved);
      message.success('已保存自动匹配字段');
      setShowMatchEdit(false);
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 搜索行 + 上传 */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <Input.Search
          placeholder="搜索模板名称"
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button type="primary" icon={<UploadOutlined />} onClick={() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.docx,.xlsx';
          input.multiple = true;
          input.onchange = (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (!files) return;
            for (const f of Array.from(files)) {
              doUpload(f, false);
            }
          };
          input.click();
        }}>
          ＋ 上传
        </Button>
      </div>

      {/* 自动匹配提示 */}
      <div
        style={{
          fontSize: 12,
          color: '#646a73',
          background: '#e8f0ff',
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          lineHeight: 1.5,
          flexShrink: 0,
        }}
      >
        <span style={{ flexShrink: 0 }}>⚙️</span>
        <span style={{ flex: 1 }}>
          自动匹配字段：<b>{currentMatchFieldName || '未设置'}</b>
          {' '}— 打开记录时自动按该字段值选择同名模板。
          <a onClick={() => setShowMatchEdit((v) => !v)} style={{ color: '#3370FF', marginLeft: 4, cursor: 'pointer' }}>
            {showMatchEdit ? '收起' : '修改'}
          </a>
        </span>
      </div>

      {showMatchEdit && (
        <div style={{ flexShrink: 0 }}>
          <Select
            style={{ width: '100%' }}
            placeholder="选择匹配字段（可清空）"
            allowClear
            loading={savingConfig}
            value={currentMatchFieldId}
            onChange={(v) => handleSaveMatchField(v)}
            options={active.fieldMetas.map((f) => ({ label: f.name, value: f.id }))}
            showSearch
            optionFilterProp="label"
          />
        </div>
      )}

      {/* 模板卡片列表 */}
      {filtered.length === 0 ? (
        <Empty description={keyword ? '无匹配模板' : '还没有模板，点右上角上传'} style={{ marginTop: 24 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((t) => {
            const isExcel = /\.xlsx$/i.test(t.name);
            return (
              <div
                key={t.name}
                style={{
                  background: '#fff',
                  borderRadius: 10,
                  padding: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  boxShadow: '0 1px 4px rgba(31,35,41,.06)',
                }}
              >
                {/* 类型图标 */}
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    background: isExcel ? '#dcffe4' : '#e8f0ff',
                    color: isExcel ? '#1a7f37' : '#3370ff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 18,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {isExcel ? 'X' : 'W'}
                </div>

                {/* 元信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: '#1f2329',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={t.name}
                  >
                    {t.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#8f959e', marginTop: 2 }}>
                    {isExcel ? 'Excel' : 'Word'} · {formatSize(t.size)} · {formatTime(t.mtime)}
                  </div>
                </div>

                {/* 操作图标 */}
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <a
                    href={tableId ? templateDownloadUrl(tableId, t.name) : undefined}
                    download
                    title="下载"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#8f959e',
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    <DownloadOutlined />
                  </a>
                  <a
                    onClick={() => openCopy(t.name)}
                    title="复制"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#8f959e',
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    <CopyOutlined />
                  </a>
                  <Popconfirm
                    title={`删除「${t.name}」？`}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => handleDelete(t.name)}
                  >
                    <a
                      title="删除"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#8f959e',
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >
                      <DeleteOutlined />
                    </a>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!copySource}
        title={`复制模板：${copySource || ''}`}
        okText="复制"
        cancelText="取消"
        onOk={handleCopy}
        onCancel={() => setCopySource(null)}
      >
        <Input
          value={copyTarget}
          onChange={(e) => setCopyTarget(e.target.value)}
          placeholder="新模板名称（.docx / .xlsx）"
          onPressEnter={handleCopy}
        />
      </Modal>
    </div>
  );
}
