import type { StampConfig, StampAnchor } from '../types';
import { STAMP_POSITION_BASE } from './docxStamp';

// ============ 电子印章叠加（预览/打印用） ============
// 背景：docx-preview 渲染 docx 中的浮动图片（wp:anchor）时，把 left/top 当作
// 「相对流位置」的偏移（非页面），因此下载用的 posOffset 注入在预览里会错位。
// 本服务在 docx-preview 渲染完成后，向渲染出的 section.docx 直接叠加绝对定位的
// <img> 印章，坐标与下载注入（docxStamp.ts）保持一致：
//   - 预设模式：印章中心点 = (base.x + offsetX)% 页宽, (base.y + offsetY + i*9)% 页高
//   - 锚定模式（anchorText 非空）：在渲染 DOM 中查找锚定文字（如"盖章"），
//     印章中心点 = 文字中心 + offsetX/offsetY 微调，多枚向下错开 i*9%
// 用 translate(-50%, -50%) 实现居中，无需预知图片宽高；宽度 = 页宽 * size/100，
// 高度随图片原始宽高比自适应。
//
// 使用场景：
//   - 预览：DocxPreview 渲染后调用
//   - 打印：print.ts 的 iframe 渲染后调用（叠加后再 waitForImages，确保打印出图）

export interface OverlayStamp {
  name: string;   // 印章文件名（仅用于日志/去重）
  base64: string; // 图片 base64（可带或不带 data: 前缀）
}

// 叠加结果：锚定文字的定位结论（供调用方持久化 anchor / 提示用户）
export interface OverlayResult {
  anchorFound: boolean;      // 是否拿到了锚点（本次查找或上次保存）
  anchorFromText: boolean;   // 本次是否在 DOM 中实时找到了锚定文字
  anchor?: StampAnchor;      // 实际使用的锚点（页面百分比，单页/兼容兜底）
  pages?: PageOverlayResult[]; // 逐页叠加结果（多页模板）
}

// 单页叠加结果（多页模板逐页上报，供调用方按页持久化 enabled/anchor）
export interface PageOverlayResult {
  pageIndex: number;         // 0-based 页索引（对应可见 section 顺序）
  enabled: boolean;          // 该页实际是否盖章
  anchorFound: boolean;      // 该页是否拿到了锚点（本次查找或上次保存）
  anchorFromText: boolean;   // 该页是否在 DOM 中实时找到了锚定文字
  anchor?: StampAnchor;      // 该页实际使用的锚点（页面百分比）
}

// 通过魔数识别 base64 图片 MIME（PNG / JPEG），缺省按 PNG
function base64Mime(b64: string): string {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  if (bin.length >= 3) {
    const c0 = bin.charCodeAt(0);
    const c1 = bin.charCodeAt(1);
    const c2 = bin.charCodeAt(2);
    if (c0 === 0x89 && c1 === 0x50 && c2 === 0x4e) return 'image/png';
    if (c0 === 0xff && c1 === 0xd8 && c2 === 0xff) return 'image/jpeg';
  }
  return 'image/png';
}

function dataUrlOf(stamp: OverlayStamp): string {
  const clean = stamp.base64.replace(/^data:[^;]+;base64,/, '');
  return `data:${base64Mime(stamp.base64)};base64,${clean}`;
}

// 在一个 section 内查找锚定文字，返回「最后一个匹配」的中心点相对该页的百分比。
// 遍历文本节点，用 Range 取匹配文字的包围盒；横向预览（rotate 90°）下做坐标反算。
function findTextInSection(section: HTMLElement, text: string): StampAnchor | null {
  const target = text.trim();
  if (!target) return null;
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  const secRect = section.getBoundingClientRect();
  const rotated = /rotate\(90deg\)/i.test(section.style.transform || '');
  let node: Node | null;
  let last: StampAnchor | null = null;
  while ((node = walker.nextNode())) {
    const idx = (node.nodeValue || '').lastIndexOf(target);
    if (idx < 0) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + target.length);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let lx: number, ly: number, w: number, h: number;
    if (rotated) {
      // rotate(90deg) origin=top-left：局部 (x,y) → 视口 (secLeft - y, secTop + x)
      lx = cy - secRect.top;
      ly = secRect.left - cx;
      w = secRect.height;
      h = secRect.width;
    } else {
      lx = cx - secRect.left;
      ly = cy - secRect.top;
      w = secRect.width;
      h = secRect.height;
    }
    if (w <= 0 || h <= 0) continue;
    last = {
      x: Math.min(99, Math.max(1, (lx / w) * 100)),
      y: Math.min(99, Math.max(1, (ly / h) * 100)),
    };
  }
  return last;
}

// 把一组印章叠加到某个已渲染的页面上（多枚自动向下错开 i*9%）
function overlayOnSection(
  section: HTMLElement,
  stamps: OverlayStamp[],
  config: StampConfig,
  anchor?: StampAnchor
): void {
  const base = STAMP_POSITION_BASE[config.position] || STAMP_POSITION_BASE['right-bottom'];
  const pageW = section.offsetWidth;
  const pageH = section.offsetHeight;
  if (!pageW || !pageH) return;

  const stampW = (pageW * config.size) / 100;

  stamps.forEach((stamp, i) => {
    const img = document.createElement('img');
    img.src = dataUrlOf(stamp);
    img.alt = stamp.name;
    img.className = 'stamp-overlay-img';
    img.style.position = 'absolute';
    img.style.width = `${stampW}px`;
    img.style.height = 'auto';
    img.style.zIndex = '1000';
    img.style.pointerEvents = 'none';
    img.style.opacity = String(config.opacity);
    img.style.userSelect = 'none';
    img.style.contain = 'layout paint';

    // 中心点（页面 %）：锚定模式下以锚点为基准（左右/上下滑杆仍可微调），多枚向下错开 i*9%
    const centerX = ((anchor ? anchor.x : base.x) + config.offsetX);
    const centerY = ((anchor ? anchor.y : base.y) + config.offsetY + i * 9);
    img.style.left = `${(pageW * centerX) / 100}px`;
    img.style.top = `${(pageH * centerY) / 100}px`;
    // translate(-50%,-50%) 让图片中心落在中心点，宽高自适应
    img.style.transform = 'translate(-50%, -50%)';

    section.appendChild(img);
  });
}

// 主入口：向渲染后的容器按页叠加印章（多页模板每页独立控制）。
// - 每页盖章开关：config.pages[i].enabled === false 则该页不盖（默认全部盖章）
// - 预设模式：每页盖在 position 预设位置（叠加 offsetX/offsetY，多枚向下错开）
// - 锚定模式（anchorText 非空）：每页独立查找锚定文字，盖在文字所在位置；
//   某页 DOM 中找不到时退回该页已保存的 pages[i].anchor，再退回全局 config.anchor
//   （仍盖在该页预设位置），并标记 anchorFound=false 供调用方提示。
export function overlayStampsOnDoc(
  container: HTMLElement,
  stamps: OverlayStamp[],
  config: StampConfig
): OverlayResult {
  const result: OverlayResult = { anchorFound: false, anchorFromText: false };
  if (!stamps.length) return result;
  const sections = Array.from(container.querySelectorAll('section.docx'))
    .filter((s) => !s.classList.contains('empty-page-hidden')) as HTMLElement[];
  if (!sections.length) return result;

  const pages: PageOverlayResult[] = [];
  let anyAnchor = false;
  let anyFromText = false;
  let lastAnchor: StampAnchor | undefined;

  sections.forEach((section, i) => {
    const pageCfg = config.pages?.[i];
    const enabled = pageCfg?.enabled !== false;
    const pr: PageOverlayResult = { pageIndex: i, enabled, anchorFound: false, anchorFromText: false };
    pages.push(pr);
    if (!enabled) return;

    let anchor: StampAnchor | undefined;
    if (config.anchorText?.trim()) {
      const hit = findTextInSection(section, config.anchorText);
      if (hit) {
        anchor = hit;
        pr.anchorFound = true;
        pr.anchorFromText = true;
        pr.anchor = hit;
      } else if (pageCfg?.anchor) {
        anchor = pageCfg.anchor;
        pr.anchorFound = true;
        pr.anchor = pageCfg.anchor;
      } else if (config.anchor) {
        anchor = config.anchor;
        pr.anchorFound = true;
      }
    }

    overlayOnSection(section, stamps, config, anchor);
    if (pr.anchorFound) { anyAnchor = true; lastAnchor = anchor; }
    if (pr.anchorFromText) anyFromText = true;
  });

  result.pages = pages;
  result.anchorFound = anyAnchor;
  result.anchorFromText = anyFromText;
  result.anchor = lastAnchor;
  return result;
}

// 便捷入口：把已渲染页面上的印章叠加层清掉（组件重渲染前用）
export function clearStampOverlay(container: HTMLElement): void {
  const imgs = Array.from(container.querySelectorAll('img.stamp-overlay-img'));
  imgs.forEach((img) => img.remove());
}
