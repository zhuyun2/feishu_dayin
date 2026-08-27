import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Slider, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import {
  PrinterOutlined, DownloadOutlined, ReloadOutlined, RotateRightOutlined,
  ZoomInOutlined, ZoomOutOutlined, ColumnWidthOutlined,
} from '@ant-design/icons';
import { saveAs } from 'file-saver';

import type { TemplateInfo, MatchConfig, MatchKind, StampAnchor, StampConfig, StampInfo } from '../types';
import { DEFAULT_STAMP_CONFIG, STAMP_POSITION_LABEL } from '../types';
import type { ActiveRecordState } from '../hooks/useActiveRecord';
import { fetchTemplateBuffer } from '../services/templateApi';
import { listStamps, fetchStampBuffer, fetchStampBase64, stampUrl } from '../services/stampApi';
import { buildPrintData } from '../services/dataBuilder';
import { fillTemplate, explainDocxError } from '../services/docxFill';
import { fillXlsx, isXlsxName } from '../services/xlsxFill';
import { stampDocxBlob, arrayBufferToBase64 } from '../services/docxStamp';
import type { OverlayStamp } from '../services/stampOverlay';
import { resolveAutoSelection } from '../services/templateMatch';
import { createRequestGate } from '../services/requestGate';
import { currentPreviewBlob } from '../services/previewBlob';
import { printDocxBlob, printHtmlTable, printCopies, printPreviewElement, printDocxAsPdf, type PrintOrientation, type PrintOverlay } from '../utils/print';
import { renderXlsxToHtml } from '../services/xlsxRender';
import DocxPreview, {
  MIN_SCALE, MAX_SCALE, SCALE_STEP, clampScale, type PreviewHandle,
} from './DocxPreview';
import XlsxPreview from './XlsxPreview';

const { Text } = Typography;

interface Props {
  active: ActiveRecordState;
  templates: TemplateInfo[];
  matchConfig: MatchConfig;
  onNeedTemplates: () => void;
  goManage: () => void;
  goStamp: () => void;
}

const KIND_LABEL: Record<MatchKind, string> = {
  exact: '精确匹配',
  contains: '包含匹配',
  reverse: '包含匹配',
  none: '',
};

const ORIENTATION_NEXT: Record<PrintOrientation, PrintOrientation> = {
  auto: 'portrait',
  portrait: 'landscape',
  landscape: 'auto',
};

const ORIENTATION_LABEL: Record<PrintOrientation, string> = {
  auto: '跟随',
  portrait: '竖向',
  landscape: '横向',
};

export default function PrintTab({ active, templates, matchConfig, onNeedTemplates, goManage, goStamp }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [matchKind, setMatchKind] = useState<MatchKind>('none');
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewTemplateName, setPreviewTemplateName] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<PrintOrientation>('auto');
  const [multiCopy, setMultiCopy] = useState(false);
  const DEFAULT_COPIES = ['生产部', '销售部', '客户', '财务部', '开票'];
  const [rendering, setRendering] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [scale, setScale] = useState(1);
  const previewRef = useRef<PreviewHandle>(null);
  const debounceRef = useRef<any>(null);
  const autoMatchGateRef = useRef(createRequestGate());
  const generationGateRef = useRef(createRequestGate());

  // ===== 电子盖章 =====
  const [stamps, setStamps] = useState<StampInfo[]>([]);
  const [stampConfig, setStampConfig] = useState<StampConfig>(DEFAULT_STAMP_CONFIG);
  const [stampPanelOpen, setStampPanelOpen] = useState(false);
  // 预览/打印叠加用的印章 base64（generate 时随预览一起取，走缓存）
  const [overlayStamps, setOverlayStamps] = useState<OverlayStamp[]>([]);
  const stampConfigRef = useRef<StampConfig>(stampConfig);
  stampConfigRef.current = stampConfig;

  // 按表加载印章列表
  useEffect(() => {
    setStamps([]);
    setOverlayStamps([]);
    if (!active.tableId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listStamps(active.tableId!);
        if (!cancelled) setStamps(list);
      } catch (e) {
        if (!cancelled) message.warning('印章列表加载失败，盖章功能不可用');
      }
    })();
    return () => { cancelled = true; };
  }, [active.tableId]);

  // 盖章配置按「表 + 模板」记忆：每个模板各自保存位置/大小/锚定文字，
  // 切换模板自动恢复，调一次之后下次直接打印无需再调
  const stampCfgKey = active.tableId && selected
    ? `print-stamp-cfg-v2:${active.tableId}::${selected}`
    : null;
  useEffect(() => {
    if (!stampCfgKey) {
      // 未选模板：显示默认配置（不落盘）
      setStampConfig((c) => ({ ...DEFAULT_STAMP_CONFIG, stamps: c.stamps }));
      return;
    }
    let restored = DEFAULT_STAMP_CONFIG;
    const saved = localStorage.getItem(stampCfgKey);
    if (saved) {
      try {
        restored = { ...DEFAULT_STAMP_CONFIG, ...(JSON.parse(saved) as StampConfig) };
      } catch (e) { /* 配置损坏则用默认 */ }
    }
    const valid = new Set(stamps.map((s) => s.name));
    setStampConfig({ ...restored, stamps: (restored.stamps || []).filter((n) => valid.has(n)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stampCfgKey, stamps]);

  // 配置变更：持久化到当前模板（含锚定文字与最近一次锚点）
  useEffect(() => {
    if (stampCfgKey) {
      localStorage.setItem(stampCfgKey, JSON.stringify(stampConfig));
    }
  }, [stampConfig, stampCfgKey]);

  // 锚定文字定位结果：写回配置持久化（下载注入 posOffset 复用同一坐标）
  const anchorWarnRef = useRef('');
  const handleStampAnchor = useCallback((a: StampAnchor | null, fromText: boolean) => {
    const cfg = stampConfigRef.current;
    if (!cfg.anchorText?.trim()) {
      anchorWarnRef.current = '';
      return;
    }
    if (!fromText) {
      // 渲染 DOM 中没找到文字：退回上次保存的 anchor 或位置预设，提示一次
      if (anchorWarnRef.current !== cfg.anchorText) {
        anchorWarnRef.current = cfg.anchorText;
        message.warning(`未在文档中找到「${cfg.anchorText}」，印章先用上次位置/位置预设`);
      }
      return;
    }
    anchorWarnRef.current = '';
    if (!a) return;
    setStampConfig((c) => {
      // 与已存锚点差异极小则不更新，避免 渲染→写回→再渲染 的循环
      if (c.anchor && Math.abs(c.anchor.x - a.x) < 0.3 && Math.abs(c.anchor.y - a.y) < 0.3) return c;
      return { ...c, anchor: a };
    });
  }, []);

  const autoMatchContext = [
    active.tableId || '', active.recordId || '', matchConfig.tables[active.tableId || '']?.matchFieldId || '',
    templates.map((t) => `${t.name}:${t.mtime}`).join('|'),
  ].join('\u0000');
  const autoMatchContextRef = useRef(autoMatchContext);
  autoMatchContextRef.current = autoMatchContext;

  const generationContext = [active.tableId || '', active.recordId || '', selected || ''].join('\u0000');
  const generationContextRef = useRef(generationContext);
  generationContextRef.current = generationContext;
  const safePreviewBlob = currentPreviewBlob(
    previewBlob && previewTemplateName ? { blob: previewBlob, templateName: previewTemplateName } : null,
    selected
  );

  const handleScaleChange = useCallback((s: number) => setScale(clampScale(s)), []);
  const handlePreviewError = useCallback((m: string) => setErrors([m]), []);
  const zoomIn = () => setScale((s) => clampScale(s + SCALE_STEP));
  const zoomOut = () => setScale((s) => clampScale(s - SCALE_STEP));
  const fitWidth = () => previewRef.current?.fitWidth();

  const matchFieldId = active.tableId ? matchConfig.tables[active.tableId]?.matchFieldId : undefined;

  const runAutoMatch = useCallback(async () => {
    const ticket = autoMatchGateRef.current.start();
    const context = autoMatchContextRef.current;
    if (!active.table || !active.recordId || !matchFieldId) {
      if (!ticket.isCurrent() || autoMatchContextRef.current !== context) return;
      setMatchKind('none');
      setSelected(null);
      return;
    }
    try {
      const value = await active.table.getCellString(matchFieldId, active.recordId);
      if (!ticket.isCurrent() || autoMatchContextRef.current !== context) return;
      const res = resolveAutoSelection(value, templates);
      setMatchKind(res.kind);
      setSelected(res.name);
    } catch (e) {
      if (!ticket.isCurrent() || autoMatchContextRef.current !== context) return;
      setMatchKind('none');
      setSelected(null);
    }
  }, [active.table, active.recordId, matchFieldId, templates]);

  useEffect(() => {
    if (selected && !templates.some((t) => t.name === selected)) {
      setSelected(null);
      setPreviewBlob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  useEffect(() => {
    autoMatchGateRef.current.invalidate();
    generationGateRef.current.invalidate();
    setManual(false);
    setSelected(null);
    setPreviewBlob(null);
    setRendering(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runAutoMatch();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      autoMatchGateRef.current.invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.tableId, active.recordId, matchFieldId, templates]);

  const generate = useCallback(async (): Promise<Blob | null> => {
    if (!selected) { message.warning('请先选择模板'); return null; }
    if (!active.table || !active.recordId) { message.warning('请先在表格中选中一条记录'); return null; }
    if (!active.tableId) { message.warning('未获取到当前数据表'); return null; }
    const ticket = generationGateRef.current.start();
    const context = generationContextRef.current;
    const isCurrent = () => ticket.isCurrent() && generationContextRef.current === context;
    setRendering(true);
    setErrors([]);
    setWarnings([]);
    try {
      const buffer = await fetchTemplateBuffer(active.tableId, selected);
      const { data, warnings: w } = await buildPrintData(
        active.table, active.tableName, active.fieldMetas, active.recordId
      );
      const isX = isXlsxName(selected);
      const blob = isX ? fillXlsx(buffer, data) : fillTemplate(buffer, data);

      // 电子盖章：预览/打印走 JS 叠加（干净 blob，docx-preview 渲染后盖 img）；
      // 下载时再另行把印章以浮动图片注入 docx（posOffset，Word 语义正确）
      const cfg = stampConfigRef.current;
      const pick = cfg.stamps.filter((n) => stamps.some((s) => s.name === n));
      let overlay: OverlayStamp[] = [];
      if (isX && pick.length > 0) {
        w.push('Excel 模板暂不支持盖章，如需盖章请使用 Word 模板');
      } else if (pick.length > 0) {
        try {
          overlay = await Promise.all(
            pick.map(async (n) => ({
              name: n,
              base64: await fetchStampBase64(active.tableId!, n),
            }))
          );
        } catch (se: any) {
          if (isCurrent()) setWarnings((prev) => [...prev, '印章读取失败，本次预览未盖章：' + (se?.message || se)]);
        }
      }

      if (!isCurrent()) return null;
      setWarnings(w);
      setOverlayStamps(overlay);
      setPreviewBlob(blob);
      setPreviewTemplateName(selected);
      return blob;
    } catch (e: any) {
      if (!isCurrent()) return null;
      setPreviewBlob(null);
      setErrors(explainDocxError(e));
      return null;
    } finally {
      if (isCurrent()) setRendering(false);
    }
  }, [selected, active.tableId, active.table, active.recordId, active.tableName, active.fieldMetas, stamps]);

  useEffect(() => {
    generationGateRef.current.invalidate();
    if (selected && active.recordId) {
      const t = setTimeout(() => generate(), 120);
      return () => {
        clearTimeout(t);
        generationGateRef.current.invalidate();
      };
    } else {
      setPreviewBlob(null);
      setRendering(false);
    }
    return () => generationGateRef.current.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.tableId, selected, active.recordId, stampConfig, generate]);

  const isXlsx = !!selected && isXlsxName(selected);

  // 按当前配置构建打印叠加层（印章 base64 走缓存，读取失败则本次不盖章）
  const buildOverlay = async (): Promise<PrintOverlay | undefined> => {
    const cfg = stampConfigRef.current;
    const pick = cfg.stamps.filter((n) => stamps.some((s) => s.name === n));
    if (!pick.length) return undefined;
    try {
      const imgs = await Promise.all(
        pick.map(async (n) => ({ name: n, base64: await fetchStampBase64(active.tableId!, n) }))
      );
      return { stamps: imgs, config: cfg };
    } catch (e) {
      return undefined;
    }
  };

  const handlePrint = async () => {
    const blob = safePreviewBlob || (await generate());
    if (!blob) return;
    try {
      if (isXlsx) {
        const html = await renderXlsxToHtml(blob);
        if (multiCopy) {
          await printCopies({ copies: DEFAULT_COPIES, orientation, htmlTable: html });
        } else {
          await printHtmlTable(html, orientation);
        }
        return;
      }
      // 单份 docx：优先走「服务端 LibreOffice 转 PDF」打印，分页/页眉页脚与 Word 打开模板一致。
      // 印章按下载语义注入（Word 浮动图片），再上传转换，PDF 里即带正确位置的章。
      if (!multiCopy) {
        try {
          let pdfSrc = blob;
          const cfg = stampConfigRef.current;
          const pick = cfg.stamps.filter((n) => stamps.some((s) => s.name === n));
          if (pick.length > 0) {
            try {
              const imgs = await Promise.all(
                pick.map(async (n) => ({
                  name: n,
                  base64: arrayBufferToBase64(await fetchStampBuffer(active.tableId!, n)),
                }))
              );
              pdfSrc = await stampDocxBlob(blob, imgs, cfg);
            } catch (se: any) {
              message.warning('印章注入失败，本次打印未盖章：' + (se?.message || se));
            }
          }
          await printDocxAsPdf(pdfSrc);
          return;
        } catch (pdfErr: any) {
          // 服务端未装 LibreOffice / 转换失败：降级为浏览器 HTML 打印（预览 DOM 直打）
          message.warning('PDF 打印不可用，已降级为浏览器打印：' + (pdfErr?.message || pdfErr));
          const previewContainer = previewRef.current?.getContainer();
          if (previewContainer && previewContainer.querySelector('section.docx')) {
            await printPreviewElement(previewContainer, orientation);
            return;
          }
        }
      }
      const overlay = await buildOverlay();
      if (multiCopy) {
        await printCopies({ copies: DEFAULT_COPIES, orientation, docxBlob: blob, overlay });
      } else {
        await printDocxBlob(blob, orientation, overlay);
      }
    } catch (e: any) {
      message.error(e?.message || '打印失败');
    }
  };

  const handleDownload = async () => {
    const clean = safePreviewBlob || (await generate());
    if (!clean) return;
    let blob = clean;
    // Word 模板 + 已选印章：下载时把印章以浮动图片注入 docx（Word 打开即带章）
    if (!isXlsx) {
      const cfg = stampConfigRef.current;
      const pick = cfg.stamps.filter((n) => stamps.some((s) => s.name === n));
      if (pick.length > 0) {
        try {
          const imgs = await Promise.all(
            pick.map(async (n) => ({
              name: n,
              base64: arrayBufferToBase64(await fetchStampBuffer(active.tableId!, n)),
            }))
          );
          blob = await stampDocxBlob(clean, imgs, cfg);
        } catch (se: any) {
          message.warning('盖章失败，已下载未盖章版本：' + (se?.message || se));
        }
      }
    }
    const ext = isXlsx ? '.xlsx' : '.docx';
    const base = selected ? selected.replace(/\.(docx|xlsx)$/i, '') : '打印';
    const suffix = active.primaryText ? `-${active.primaryText}` : '';
    saveAs(blob, `${base}${suffix}${ext}`);
  };

  const templateOptions = useMemo(
    () => templates.map((t) => ({ label: t.name, value: t.name })),
    [templates]
  );

  const noRecord = !active.recordId;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 可滚动内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {active.error && (
          <Alert type="error" showIcon message={`连接多维表格出错：${active.error}`} style={{ flexShrink: 0 }} />
        )}
        {noRecord && (
          <Alert type="warning" showIcon message="请在左侧表格中选中一条记录" style={{ flexShrink: 0 }} />
        )}

        {/* 模板选择行 */}
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(31,35,41,.06)', padding: 12, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Select
            style={{ flex: 1 }}
            placeholder={templates.length ? '选择模板' : '暂无模板，请先在"模板管理"上传'}
            showSearch
            allowClear
            value={selected}
            onChange={(v) => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              autoMatchGateRef.current.invalidate();
              setSelected(v ?? null);
              setManual(!!v);
              setMatchKind('none');
            }}
            options={templateOptions}
            optionFilterProp="label"
            notFoundContent={<a onClick={goManage}>去模板管理上传</a>}
          />
          {selected && !manual && matchKind !== 'none' && (
            <Tag color="green" style={{ margin: 0 }}>{KIND_LABEL[matchKind]}</Tag>
          )}
          {selected && manual && <Tag color="blue" style={{ margin: 0 }}>手动选择</Tag>}
          {selected && !manual && matchKind === 'none' && matchFieldId && (
            <Tag style={{ margin: 0 }}>未自动匹配</Tag>
          )}
        </div>
        {!matchFieldId && active.recordId && (
          <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
            未设置自动匹配字段，<a onClick={goManage}>去设置</a>后可按记录自动选模板。
          </Text>
        )}

        {/* 电子盖章面板 */}
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(31,35,41,.06)', padding: '0 12px', flexShrink: 0 }}>
          <div
            onClick={() => setStampPanelOpen((v) => !v)}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '9px 0', userSelect: 'none' }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2329' }}>📌 电子盖章</span>
            {stampConfig.stamps.length > 0 && (
              <Tag color="red" style={{ margin: '0 0 0 8px' }}>{stampConfig.stamps.length}枚</Tag>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8f959e' }}>
              {stampPanelOpen ? '收起 ▲' : '展开 ▼'}
            </span>
          </div>
          {stampPanelOpen && (
            <div style={{ paddingBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: '#646a73', marginBottom: 6 }}>
                  选择印章（可多选，多枚自动向下错开；勾选后预览/打印/下载自动带上）
                </div>
                {stamps.length === 0 ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    还没有印章，<a onClick={goStamp}>去「印章」页上传</a>（支持 PNG / JPG）
                  </Text>
                ) : (
                  <Checkbox.Group
                    value={stampConfig.stamps}
                    onChange={(v) => setStampConfig((c) => ({ ...c, stamps: v as string[] }))}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}
                  >
                    {stamps.map((s) => (
                      <Checkbox key={s.name} value={s.name} style={{ fontSize: 12 }}>
                        <img
                          src={active.tableId ? stampUrl(active.tableId, s.name) : undefined}
                          alt=""
                          style={{ width: 18, height: 18, marginRight: 5, verticalAlign: 'middle', objectFit: 'contain' }}
                        />
                        <span style={{ verticalAlign: 'middle' }}>{s.name}</span>
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>位置</span>
                <Select
                  size="small"
                  style={{ flex: 1 }}
                  value={stampConfig.position}
                  onChange={(v) => setStampConfig((c) => ({ ...c, position: v }))}
                  options={Object.entries(STAMP_POSITION_LABEL).map(([value, label]) => ({ value, label }))}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>锚定</span>
                <Input
                  size="small"
                  style={{ flex: 1 }}
                  allowClear
                  placeholder="输入文档中的文字（如 盖章），印章盖在文字上"
                  value={stampConfig.anchorText || ''}
                  onChange={(e) => setStampConfig((c) => ({ ...c, anchorText: e.target.value }))}
                />
              </div>
              {stampConfig.anchorText?.trim() ? (
                <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5, marginTop: -4 }}>
                  已按「{stampConfig.anchorText.trim()}」文字定位{stampConfig.anchor ? '（已记住该模板位置）' : ''}；
                  下方左右/上下滑杆可在此基础上微调，清空输入框则改用位置预设。
                </Text>
              ) : null}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>大小</span>
                <Slider
                  style={{ flex: 1, margin: '2px 0' }}
                  min={5} max={50} step={1}
                  value={stampConfig.size}
                  onChange={(v) => setStampConfig((c) => ({ ...c, size: v as number }))}
                  tooltip={{ formatter: (v) => `宽 ${v}%` }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>浓度</span>
                <Slider
                  style={{ flex: 1, margin: '2px 0' }}
                  min={0.1} max={1} step={0.05}
                  value={stampConfig.opacity}
                  onChange={(v) => setStampConfig((c) => ({ ...c, opacity: v as number }))}
                  tooltip={{ formatter: (v) => `${Math.round((v as number) * 100)}%` }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>左右</span>
                <Slider
                  style={{ flex: 1, margin: '2px 0' }}
                  min={-40} max={40} step={1}
                  value={stampConfig.offsetX}
                  onChange={(v) => setStampConfig((c) => ({ ...c, offsetX: v as number }))}
                  tooltip={{ formatter: (v) => `${(v ?? 0) > 0 ? '右移' : (v ?? 0) < 0 ? '左移' : ''}${Math.abs(v ?? 0)}%` }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#646a73', width: 48, flexShrink: 0 }}>上下</span>
                <Slider
                  style={{ flex: 1, margin: '2px 0' }}
                  min={-40} max={40} step={1}
                  value={stampConfig.offsetY}
                  onChange={(v) => setStampConfig((c) => ({ ...c, offsetY: v as number }))}
                  tooltip={{ formatter: (v) => `${(v ?? 0) > 0 ? '下移' : (v ?? 0) < 0 ? '上移' : ''}${Math.abs(v ?? 0)}%` }}
                />
              </div>

              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                印章以半透明浮于文字上方（模拟油墨）。盖章设置按模板自动记忆：每个模板调好一次，之后打印直接沿用，无需重复调整。
              </Text>
            </div>
          )}
        </div>

        {/* 错误 / 警告 */}
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="模板填充失败"
            style={{ flexShrink: 0 }}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            }
          />
        )}
        {warnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="数据提示"
            style={{ flexShrink: 0 }}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            }
          />
        )}

        {/* 预览卡 */}
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(31,35,41,.06)', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 200 }}>
          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid #e5e6eb', background: '#fafbfc', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2329', marginRight: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>打印预览</span>

            {/* 缩放控件：放在预览面板外，不会被 zoom 影响 */}
            <Space size={2}>
              <Tooltip title="缩小 (Ctrl+滚轮)">
                <Button size="small" icon={<ZoomOutOutlined />} onClick={zoomOut} disabled={!safePreviewBlob || scale <= MIN_SCALE} />
              </Tooltip>
              <Tooltip title="放大 (Ctrl+滚轮)">
                <Button size="small" icon={<ZoomInOutlined />} onClick={zoomIn} disabled={!safePreviewBlob || scale >= MAX_SCALE} />
              </Tooltip>
              <Tooltip title="适应宽度">
                <Button size="small" icon={<ColumnWidthOutlined />} onClick={fitWidth} disabled={!safePreviewBlob} />
              </Tooltip>
            </Space>
            <div style={{ width: 90 }}>
              <Slider
                min={MIN_SCALE} max={MAX_SCALE} step={SCALE_STEP}
                value={scale} onChange={(v) => setScale(clampScale(v as number))}
                disabled={!safePreviewBlob} tooltip={{ open: false }}
              />
            </div>
            <span style={{ fontSize: 12, color: '#6b7280', minWidth: 38, textAlign: 'right' }}>{Math.round(scale * 100)}%</span>

            <div style={{ width: 1, height: 16, background: '#e5e6eb', margin: '0 4px' }} />

            <Tooltip title="刷新预览">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={generate}
                disabled={!selected || noRecord}
              />
            </Tooltip>

            <div style={{ width: 1, height: 16, background: '#e5e6eb', margin: '0 4px' }} />

            <Tooltip title="打印方向：五联货单等横向内容，若 Word 是竖版排版导致打印被裁切，选「横向」会自动旋转 90°">
              <Button
                size="small"
                icon={<RotateRightOutlined />}
                onClick={() => setOrientation((o) => ORIENTATION_NEXT[o])}
              >
                {ORIENTATION_LABEL[orientation]}
              </Button>
            </Tooltip>

            <Tooltip title={multiCopy ? '一次连打 5 份（生产部/销售部/客户/财务部/开票）' : '单份打印'}>
              <Button
                size="small"
                type={multiCopy ? 'primary' : 'default'}
                onClick={() => setMultiCopy((v) => !v)}
              >
                {multiCopy ? '5联' : '单联'}
              </Button>
            </Tooltip>
          </div>

          {/* Preview body */}
          <div style={{ flex: 1, background: '#eceef1', overflow: 'hidden', padding: 16, display: 'flex' }}>
            <Spin spinning={rendering} tip="正在生成预览…" wrapperClassName="preview-spin" style={{ width: '100%' }}>
              {isXlsx
                ? <XlsxPreview ref={previewRef} blob={safePreviewBlob} scale={scale} onScaleChange={handleScaleChange} onError={handlePreviewError} />
                : <DocxPreview ref={previewRef} blob={safePreviewBlob} orientation={orientation} scale={scale} onScaleChange={handleScaleChange} onError={handlePreviewError} overlayStamps={overlayStamps} overlayConfig={stampConfig} onStampAnchor={handleStampAnchor} />}
            </Spin>
          </div>
        </div>
      </div>

      {/* 底部固定操作栏 */}
      <div style={{ background: '#fff', borderTop: '1px solid #e5e6eb', padding: '10px 16px', display: 'flex', gap: 10, flexShrink: 0 }}>
        <Button
          type="primary"
          style={{ flex: 1, height: 38, borderRadius: 8, fontSize: 14, fontWeight: 500 }}
          onClick={handlePrint}
          disabled={!selected || noRecord}
        >
          <PrinterOutlined /> {multiCopy ? '打印(5联)' : '打印'}
        </Button>
        <Button
          style={{ flex: 1, height: 38, borderRadius: 8, border: '1px solid #e5e6eb', fontSize: 14, fontWeight: 500 }}
          onClick={handleDownload}
          disabled={!selected || noRecord}
        >
          <DownloadOutlined /> 下载
        </Button>
      </div>
    </div>
  );
}
