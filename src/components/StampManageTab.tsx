import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Popconfirm, message } from 'antd';
import { UploadOutlined, DeleteOutlined } from '@ant-design/icons';
import type { StampInfo } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { listStamps, uploadStamp, deleteStamp, stampUrl } from '../services/stampApi';

interface Props {
  active: ActiveRecordState;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function StampManageTab({ active }: Props) {
  const [stamps, setStamps] = useState<StampInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const tableId = active.tableId;

  const refresh = useCallback(async () => {
    if (!tableId) return;
    try {
      const list = await listStamps(tableId);
      setStamps(list);
    } catch (e: any) {
      message.error('读取印章列表失败：' + (e?.message || e));
    }
  }, [tableId]);

  useEffect(() => {
    setStamps([]);
    refresh();
  }, [tableId, refresh]);

  const doUpload = async (file: File) => {
    if (!tableId) { message.error('未连接到数据表，无法上传'); return; }
    if (!/\.(png|jpe?g)$/i.test(file.name)) {
      message.error('仅支持 .png / .jpg / .jpeg 图片');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const res = await uploadStamp(tableId, file.name, buf);
      if (res.ok) {
        const tip = res.stripped
          ? `已上传印章 ${file.name}（白底已自动去除）`
          : `已上传印章 ${file.name}`;
        message.success(tip);
        refresh();
      } else {
        message.error(res.error || '上传失败');
      }
    } catch (e: any) {
      message.error(e?.message || '上传失败');
    }
  };

  const handleDelete = async (name: string) => {
    if (!tableId) return;
    try {
      await deleteStamp(tableId, name);
      message.success(`已删除 ${name}`);
      refresh();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 上传行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Button
          type="primary"
          icon={<UploadOutlined />}
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.png,.jpg,.jpeg';
            input.multiple = true;
            input.onchange = (e) => {
              const files = (e.target as HTMLInputElement).files;
              if (!files) return;
              for (const f of Array.from(files)) doUpload(f);
            };
            input.click();
          }}
        >
          ＋ 上传印章
        </Button>
        <span style={{ fontSize: 12, color: '#8f959e' }}>支持 PNG / JPG，建议使用透明背景的红色印章 PNG</span>
      </div>

      {/* 使用说明 */}
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
        <span style={{ flexShrink: 0 }}>🔏</span>
        <span style={{ flex: 1 }}>
          上传后到「打印」页勾选印章即可盖章。白底印章图片上传后会自动去白底（转为透明背景）。印章以半透明方式浮于文档上方，预览、打印、下载的 Word 均会带上印章。默认盖在页面右下角，可在打印页调整位置、大小与透明度。
        </span>
      </div>

      {/* 印章网格 */}
      {loading && stamps.length === 0 ? null : stamps.length === 0 ? (
        <Empty description="还没有印章，点上方按钮上传" style={{ marginTop: 24 }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
          {stamps.map((s) => (
            <div
              key={s.name}
              style={{
                background: '#fff',
                borderRadius: 10,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                boxShadow: '0 1px 4px rgba(31,35,41,.06)',
                position: 'relative',
              }}
            >
              <div
                style={{
                  width: 84,
                  height: 84,
                  borderRadius: 8,
                  background: '#f5f6f7',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                <img
                  src={tableId ? stampUrl(tableId, s.name) : undefined}
                  alt={s.name}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: '#1f2329',
                  width: '100%',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={s.name}
              >
                {s.name}
              </div>
              <div style={{ fontSize: 11, color: '#8f959e' }}>{formatSize(s.size)}</div>
              <Popconfirm
                title={`删除印章「${s.name}」？`}
                okText="删除"
                cancelText="取消"
                onConfirm={() => handleDelete(s.name)}
              >
                <a
                  title="删除"
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#8f959e',
                    background: 'rgba(255,255,255,.9)',
                    cursor: 'pointer',
                  }}
                >
                  <DeleteOutlined />
                </a>
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
