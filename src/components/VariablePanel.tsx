import React, { useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Input, Space, Switch, Tag, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { bitable, FieldType } from '@lark-base-open/js-sdk';
import type { FieldMetaLite } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { orderFields } from '../utils/fieldOrder';

const { Text, Paragraph } = Typography;

const LINK_TYPES = [FieldType.SingleLink, FieldType.DuplexLink];

const SYSTEM_VARS = ['打印日期', '打印时间', '数据表名称', '记录ID'];

interface Props {
  active: ActiveRecordState;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch (e) {
    // 退化方案
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); message.success('已复制'); }
    catch (e2) { message.error('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }
}

// 一行可复制的变量
function VarRow({ tag }: { tag: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
      <Text code style={{ fontSize: 13 }}>{tag}</Text>
      <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyText(tag)} />
    </div>
  );
}

export default function VariablePanel({ active }: Props) {
  // 关联字段的子表字段缓存：{ [fieldId]: 子字段名[] }
  const [childFields, setChildFields] = useState<Record<string, string[]>>({});
  const [loadingChild, setLoadingChild] = useState<Record<string, boolean>>({});
  const childFieldsRef = useRef<Record<string, string[]>>({});
  const [keyword, setKeyword] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  const ordered = useMemo(
    () => orderFields(active.fieldMetas, active.visibleFieldIds),
    [active.fieldMetas, active.visibleFieldIds]
  );
  const kw = keyword.trim().toLowerCase();
  const kwMatch = (name: string) => !kw || name.toLowerCase().includes(kw);
  const visibleNormal = useMemo(
    () => ordered.visible.filter((f) => LINK_TYPES.indexOf(f.type) === -1 && kwMatch(f.name)),
    [ordered, kw]
  );
  const hiddenNormal = useMemo(
    () => ordered.hidden.filter((f) => LINK_TYPES.indexOf(f.type) === -1 && kwMatch(f.name)),
    [ordered, kw]
  );
  const linkFields = useMemo(
    () => ordered.visible.concat(ordered.hidden).filter((f) => LINK_TYPES.indexOf(f.type) !== -1 && kwMatch(f.name)),
    [ordered, kw]
  );

  const loadChildFields = async (meta: FieldMetaLite) => {
    if (childFieldsRef.current[meta.id] || loadingChild[meta.id]) return;
    const tableId = meta.property?.tableId;
    if (!tableId) return;
    setLoadingChild((s) => ({ ...s, [meta.id]: true }));
    try {
      const childTable = await bitable.base.getTableById(tableId);
      const metas = (await childTable.getFieldMetaList()) as unknown as FieldMetaLite[];
      let names = metas.map((m) => m.name);
      try {
        const view = await childTable.getActiveView();
        const vids = await view.getVisibleFieldIdList();
        if (Array.isArray(vids) && vids.length) {
          const order = new Map(metas.map((m) => [m.id, m.name] as const));
          const orderedNames = vids.map((id: string) => order.get(id)).filter(Boolean) as string[];
          if (orderedNames.length) names = orderedNames;
        }
      } catch (e) { /* 退回原序 */ }
      childFieldsRef.current[meta.id] = names;
      setChildFields((s) => ({ ...s, [meta.id]: names }));
    } catch (e) {
      childFieldsRef.current[meta.id] = [];
      setChildFields((s) => ({ ...s, [meta.id]: [] }));
    } finally {
      setLoadingChild((s) => ({ ...s, [meta.id]: false }));
    }
  };

  // 生成关联字段的循环片段
  const loopSnippet = (fieldName: string, subFields: string[]): string => {
    const cols = ['序号', ...subFields];
    const cells = cols.map((c) => `{${c}}`).join('\t');
    return `{#${fieldName}}${cells}{/${fieldName}}`;
  };

  // 复制全部变量（多行文本，粘进 Word 即为起始模板）
  const copyAll = async () => {
    // 预加载所有关联字段子表（A5）
    await Promise.all(linkFields.map((f) => loadChildFields(f)));
    const lines: string[] = [];
    lines.push('=== 系统变量 ===');
    SYSTEM_VARS.forEach((v) => lines.push(`{${v}}`));
    lines.push('');
    lines.push('=== 字段变量 ===');
    visibleNormal.concat(showHidden ? hiddenNormal : []).forEach((f) => lines.push(`{${f.name}}`));
    linkFields.forEach((f) => {
      lines.push('');
      lines.push(`=== 关联字段「${f.name}」循环（放进表格同一行）===`);
      const subs = childFieldsRef.current[f.id] || ['(子字段未加载)'];
      lines.push(loopSnippet(f.name, subs));
      lines.push(`整段文本：{${f.name}_文本}`);
    });
    copyText(lines.join('\n'));
  };

  const collapseItems = linkFields.map((f) => ({
    key: f.id,
    label: <span>{f.name} <Tag color="purple">关联</Tag></span>,
    children: (
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          循环片段（把整段放进 Word 表格的一行里，每条关联记录会复制成一行）：
        </Text>
        <Paragraph
          code
          copyable={{ text: loopSnippet(f.name, childFields[f.id] || []) }}
          style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}
        >
          {loopSnippet(f.name, childFields[f.id] || [])}
        </Paragraph>
        <Text type="secondary" style={{ fontSize: 12 }}>子表字段：</Text>
        {(childFields[f.id] || []).length === 0 ? (
          <div><Text type="secondary" style={{ fontSize: 12 }}>{loadingChild[f.id] ? '加载中…' : '无'}</Text></div>
        ) : (
          (childFields[f.id] || []).map((name) => <VarRow key={name} tag={`{${name}}`} />)
        )}
        <VarRow tag={`{${f.name}_文本}`} />
      </div>
    ),
  }));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Alert
        type="info"
        showIcon
        message="如何制作模板"
        description={
          <div style={{ fontSize: 12 }}>
            <p style={{ margin: '2px 0' }}>1. 在 Word 里排好版式，把下面的变量粘贴到需要填数据的位置。</p>
            <p style={{ margin: '2px 0' }}>2. 关联字段用循环片段 <Text code>{'{#字段}…{/字段}'}</Text>，开始和结束标签要放在 Word 表格的同一行，每条关联记录会自动复制成一行。</p>
            <p style={{ margin: '2px 0' }}>3. 保存为 .docx，到「模板管理」上传。文件名（去掉 .docx）等于匹配字段的值时会自动匹配。</p>
            <p style={{ margin: '2px 0' }}>4. 附件字段只输出文件名，不插入图片。字段与系统变量重名时以真实字段为准。</p>
            <p style={{ margin: '2px 0' }}>5. <strong>分页与求和</strong>：在模板正文任意处放一行指令（渲染时自动隐藏）：<br/>
              <Text code>{'@@PAGE field=产品明细 size=5 sum=数量:合计数量,金额:合计金额 @@'}</Text><br/>
              field=循环明细字段；size=每页行数；sum=需求和的数字列（col:输出变量，多个用逗号）。超量时自动拆成多页同格式出货单，并注入 <Text code>{'{合计数量}'}</Text>、<Text code>{'{页码}'}</Text>、<Text code>{'{总页数}'}</Text>。复制后的模板可在「模板编辑」里直接改这行参数。</p>
          </div>
        }
      />

      <Button icon={<CopyOutlined />} onClick={copyAll} block>复制全部变量</Button>

      <Space style={{ width: '100%' }} direction="vertical" size={8}>
        <Input.Search placeholder="搜索变量名" allowClear value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <div><Switch size="small" checked={showHidden} onChange={setShowHidden} /> <Text type="secondary" style={{ fontSize: 12 }}>显示隐藏字段</Text></div>
      </Space>

      <Card size="small" title="系统变量">
        {SYSTEM_VARS.map((v) => <VarRow key={v} tag={`{${v}}`} />)}
      </Card>

      <Card size="small" title={`字段变量（${visibleNormal.length}${showHidden && hiddenNormal.length ? ` +${hiddenNormal.length}隐藏` : ''}）`}>
        {visibleNormal.length === 0 && (!showHidden || hiddenNormal.length === 0) ? (
          <Text type="secondary">{kw ? '无匹配字段' : '当前表无普通字段'}</Text>
        ) : (
          <>
            {visibleNormal.map((f) => <VarRow key={f.id} tag={`{${f.name}}`} />)}
            {showHidden && hiddenNormal.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag color="default" style={{ fontSize: 11, margin: 0 }}>隐藏</Tag>
                <div style={{ flex: 1 }}><VarRow tag={`{${f.name}}`} /></div>
              </div>
            ))}
          </>
        )}
      </Card>

      {linkFields.length > 0 && (
        <Card size="small" title={`关联字段（${linkFields.length}）`}>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
            循环标签要放在 Word 表格<strong>同一行</strong>：首格放 <Text code>{'{#字段}'}</Text>，末格放 <Text code>{'{/字段}'}</Text>。
            <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
              <tbody>
                <tr><td style={{border:'1px solid #ddd',padding:'2px 6px'}}>序号</td><td style={{border:'1px solid #ddd',padding:'2px 6px'}}>名称</td><td style={{border:'1px solid #ddd',padding:'2px 6px'}}>数量</td></tr>
                <tr><td style={{border:'1px solid #ddd',padding:'2px 6px',background:'#fffbe6'}}>{'{#明细}{序号}'}</td><td style={{border:'1px solid #ddd',padding:'2px 6px'}}>{'{名称}'}</td><td style={{border:'1px solid #ddd',padding:'2px 6px',background:'#fffbe6'}}>{'{数量}{/明细}'}</td></tr>
              </tbody>
            </table>
          </div>
          <Collapse
            items={collapseItems}
            onChange={(keys) => {
              const arr = Array.isArray(keys) ? keys : [keys];
              arr.forEach((k) => {
                const meta = linkFields.find((f) => f.id === k);
                if (meta) loadChildFields(meta);
              });
            }}
          />
        </Card>
      )}
    </div>
  );
}
