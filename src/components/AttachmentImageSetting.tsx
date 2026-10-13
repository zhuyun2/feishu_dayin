import React, { useEffect, useRef, useState } from 'react';
import { InputNumber, Tag, Typography } from 'antd';
import type { AttachSizeConfig } from '../types';
import { DEFAULT_ATTACH_WIDTH_CM } from '../services/attachmentImages';

const { Text } = Typography;

// ============ 附件图片设置面板 ============
// 附件字段若含图片，会在 {字段名} 处按此处设置的宽度等比插入图片；
// 非图片附件不受影响，仍输出文件名。设置按「数据表 + 字段名」保存到 _config.json。

interface Props {
  fields: string[];                 // 本表的附件字段名
  config?: Record<string, AttachSizeConfig>;
  onChange: (next: Record<string, AttachSizeConfig>) => void;
  open: boolean;
  onToggle: () => void;
}

export default function AttachmentImageSetting({ fields, config, onChange, open, onToggle }: Props) {
  const [local, setLocal] = useState<Record<string, number>>({});
  const saveTimerRef = useRef<any>(null);

  // 字段集或已存配置变化时同步本地输入值
  useEffect(() => {
    const next: Record<string, number> = {};
    fields.forEach((f) => {
      const w = config?.[f]?.widthCm;
      next[f] = typeof w === 'number' && w > 0 ? w : DEFAULT_ATTACH_WIDTH_CM;
    });
    setLocal(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.join('\u0000'), JSON.stringify(config || {})]);

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  const commit = (next: Record<string, number>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const out: Record<string, AttachSizeConfig> = {};
      Object.keys(next).forEach((f) => { out[f] = { widthCm: next[f] }; });
      onChange(out);
    }, 500);
  };

  const handleChange = (field: string, v: number | null) => {
    const w = typeof v === 'number' && v > 0 ? v : DEFAULT_ATTACH_WIDTH_CM;
    const next = { ...local, [field]: w };
    setLocal(next);
    commit(next);
  };

  return (
    <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(31,35,41,.06)', padding: '0 12px', flexShrink: 0 }}>
      <div
        onClick={onToggle}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '9px 0', userSelect: 'none' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2329' }}>🖼 附件图片</span>
        {fields.length > 0 && (
          <Tag color="cyan" style={{ margin: '0 0 0 8px' }}>{fields.length} 个附件字段</Tag>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8f959e' }}>
          {open ? '收起 ▲' : '展开 ▼'}
        </span>
      </div>
      {open && (
        <div style={{ paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {fields.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
              本表暂无附件字段。附件字段中的图片会自动插入到模板的
              <Text code style={{ fontSize: 12 }}>{'{字段名}'}</Text>
              位置，非图片附件仍输出文件名。
            </Text>
          ) : (
            <>
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
                附件字段中的图片按下方宽度等比插入模板 <Text code style={{ fontSize: 12 }}>{'{字段名}'}</Text> 位置；
                非图片附件不受影响，仍输出文件名。需模板中存在对应占位符才生效。
              </Text>
              {fields.map((f) => (
                <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{ fontSize: 12, color: '#646a73', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={f}
                  >
                    {f}
                  </span>
                  <InputNumber
                    size="small"
                    style={{ width: 92 }}
                    min={0.5}
                    max={50}
                    step={0.5}
                    value={local[f]}
                    onChange={(v) => handleChange(f, v as number | null)}
                    addonAfter="cm"
                  />
                </div>
              ))}
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                高度按图片原始比例自动；宽度留空则用默认 {DEFAULT_ATTACH_WIDTH_CM}cm。
              </Text>
            </>
          )}
        </div>
      )}
    </div>
  );
}
