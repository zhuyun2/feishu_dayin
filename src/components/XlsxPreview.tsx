import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { renderXlsxToHtml } from '../services/xlsxRender';
import { clampScale, SCALE_STEP, type PreviewHandle } from './DocxPreview';

interface Props {
  blob: Blob | null;
  scale: number;
  onScaleChange: (s: number) => void;
  onError?: (msg: string) => void;
}

// xlsx 保真预览：用 exceljs 读取单元格值+样式，渲染成 HTML 表格。
// 缩放状态由父组件控制，工具条放在预览面板外，避免工具条被一起缩放。
const XlsxPreview = forwardRef<PreviewHandle, Props>(function XlsxPreview(
  { blob, scale, onScaleChange, onError }, ref
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const fitWidth = useCallback(() => {
    const scroll = scrollRef.current;
    const el = containerRef.current;
    if (!scroll || !el) return;
    const table = el.querySelector('table') as HTMLElement | null;
    if (!table) return;
    const pageW = table.offsetWidth;
    if (!pageW) return;
    const avail = scroll.clientWidth - 24;
    onScaleChange(clampScale(avail / pageW));
  }, [onScaleChange]);

  useImperativeHandle(ref, () => ({ fitWidth }), [fitWidth]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!blob) { el.innerHTML = ''; setHasContent(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const html = await renderXlsxToHtml(blob);
        if (cancelled) return;
        el.innerHTML = html;
        setHasContent(true);
        requestAnimationFrame(() => fitWidth());
      } catch (e: any) {
        if (!cancelled && onError) onError(e?.message || 'Excel 预览渲染失败');
      }
    })();
    return () => { cancelled = true; };
  }, [blob, fitWidth, onError]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    onScaleChange(clampScale(scale + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)));
  }, [scale, onScaleChange]);

  return (
    <div
      ref={scrollRef}
      onWheel={onWheel}
      style={{ width: '100%', height: '100%', overflow: 'auto', display: 'flex', justifyContent: 'center' }}
    >
      {!blob && (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '48px 0', fontSize: 13 }}>
          选择 Excel 模板后在此预览打印效果
        </div>
      )}
      <div ref={containerRef} style={{
        // CSS zoom 会真正改变 layout box，水平滚动条才能正确计算滚动范围
        zoom: scale,
        display: 'inline-block',
      }} />
    </div>
  );
});

export default XlsxPreview;
