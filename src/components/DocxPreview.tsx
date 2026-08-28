import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { renderAsync } from 'docx-preview';

import { injectHeaderFallback } from '../services/docxHeaderFallback';
import { overlayStampsOnDoc, type OverlayStamp, type OverlayResult, type PageOverlayResult } from '../services/stampOverlay';
import { hideEmptySections } from '../utils/print';
import type { StampConfig, StampAnchor } from '../types';

type Orientation = 'auto' | 'portrait' | 'landscape';

export interface PreviewHandle {
  fitWidth: () => void;
  // 获取当前渲染容器，供打印时直接克隆预览 DOM，确保打印输出与预览一致
  getContainer: () => HTMLDivElement | null;
}

interface Props {
  blob: Blob | null;
  orientation?: Orientation;
  scale: number;
  onScaleChange: (s: number) => void;
  onError?: (msg: string) => void;
  // 电子印章叠加：docx-preview 渲染后，向各页叠加印章（与下载注入坐标一致，按页控制）
  overlayStamps?: OverlayStamp[];
  overlayConfig?: StampConfig;
  // 逐页锚定文字定位结果回调（每次渲染叠加后上报，供打印页按页持久化 anchor）
  onStampAnchors?: (results: PageOverlayResult[]) => void;
  // 渲染完成后可见页数回调（供打印页渲染「盖章页面」开关组）
  onPageCount?: (n: number) => void;
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.5;
export const SCALE_STEP = 0.1;

export function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v * 100) / 100));
}

// 用 docx-preview 把填充后的 docx 渲染为纸张视图，供用户校对数据。
// 缩放通过 CSS transform scale 实现，只影响预览显示，不影响下载/打印。
// 缩放状态由父组件控制，工具条放在预览面板外，避免工具条自身被一起缩放。
const DocxPreview = forwardRef<PreviewHandle, Props>(function DocxPreview(
  { blob, orientation = 'auto', scale, onScaleChange, onError, overlayStamps, overlayConfig, onStampAnchors, onPageCount }, ref
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);
  const orientationRef = useRef<Orientation>(orientation);
  useEffect(() => { orientationRef.current = orientation; }, [orientation]);
  // 回调走 ref，避免因回调身份变化触发整页重渲染
  const anchorCbRef = useRef(onStampAnchors);
  useEffect(() => { anchorCbRef.current = onStampAnchors; });
  const pageCountCbRef = useRef(onPageCount);
  useEffect(() => { pageCountCbRef.current = onPageCount; });

  // 适应宽度：按容器可用宽度 / 页面实际宽度 计算缩放比
  const fitWidth = useCallback(() => {
    const scroll = scrollRef.current;
    const el = containerRef.current;
    if (!scroll || !el) return;
    const section = el.querySelector('section.docx') as HTMLElement | null;
    if (!section) return;
    const pageW = orientationRef.current === 'landscape' ? section.offsetHeight : section.offsetWidth;
    if (!pageW) return;
    const avail = scroll.clientWidth - 24;
    onScaleChange(clampScale(avail / pageW));
  }, [onScaleChange]);

  useImperativeHandle(ref, () => ({ fitWidth, getContainer: () => containerRef.current }), [fitWidth]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!blob) {
      el.innerHTML = '';
      setHasContent(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        el.innerHTML = '';
        await renderAsync(blob, el, undefined, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          useBase64URL: true,
          experimental: true,
        });
        if (cancelled) return;
        await injectHeaderFallback(blob, el);
        if (cancelled) return;
        // 先隐藏只含页眉页脚的空页，再叠加印章：保证页索引对应「可见页」，
        // 且不会把章盖到将被隐藏的空页上
        if (el.ownerDocument) hideEmptySections(el.ownerDocument);
        const visibleCount = Array.from(el.querySelectorAll('section.docx'))
          .filter((s) => !s.classList.contains('empty-page-hidden')).length;
        // 电子印章叠加：渲染完成后按页盖章（锚定模式下每页独立查找锚定文字）
        let overlayRes: OverlayResult | undefined;
        if (overlayStamps && overlayStamps.length > 0 && overlayConfig) {
          overlayRes = overlayStampsOnDoc(el, overlayStamps, overlayConfig);
        }
        if (overlayRes?.pages && anchorCbRef.current) {
          anchorCbRef.current(overlayRes.pages);
        }
        if (pageCountCbRef.current) {
          pageCountCbRef.current(visibleCount);
        }
        setHasContent(true);
        requestAnimationFrame(() => fitWidth());
      } catch (e: any) {
        if (!cancelled && onError) onError(e?.message || '预览渲染失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, onError, fitWidth, overlayStamps, overlayConfig]);

  // 横向预览：把每个渲染出的 section 旋转 90°，视觉上与横版打印一致。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasContent) return;
    const sections = Array.from(el.querySelectorAll('section.docx')) as HTMLElement[];
    sections.forEach((sec) => {
      if (orientation === 'landscape') {
        const w = sec.offsetWidth;
        const h = sec.offsetHeight;
        sec.style.transform = 'rotate(90deg)';
        sec.style.transformOrigin = 'top left';
        sec.style.left = `${h}px`;
        sec.style.position = 'relative';
        sec.style.marginBottom = `${w - h}px`;
      } else {
        sec.style.transform = '';
        sec.style.transformOrigin = '';
        sec.style.left = '';
        sec.style.position = '';
        sec.style.marginBottom = '';
      }
    });
    requestAnimationFrame(() => fitWidth());
  }, [orientation, hasContent, blob, fitWidth]);

  // Ctrl/Cmd + 滚轮缩放
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
          选择模板后在此预览打印效果
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top center',
          transition: 'transform 0.12s ease-out',
        }}
      />
    </div>
  );
});

export default DocxPreview;
