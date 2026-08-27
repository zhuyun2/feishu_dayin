import { renderAsync } from 'docx-preview';
import { injectHeaderFallback } from '../services/docxHeaderFallback';
import { overlayStampsOnDoc, type OverlayStamp } from '../services/stampOverlay';
import type { StampConfig } from '../types';

// 打印时叠加的印章数据（可选）
export interface PrintOverlay {
  stamps: OverlayStamp[];
  config: StampConfig;
}

// 用隐藏的同源 iframe 渲染填充后的 docx 并调用打印。
// 目标：尽量贴近 Word 打开的效果——保留签名等图片、页面尺寸跟随文档、颜色不被浏览器淡化。
//
// 关键点：
// 1. useBase64URL:true —— 图片内联为 base64，避免 blob: URL 在打印上下文里失效导致签名图丢失。
// 2. hideWrapperOnPrint:true —— 打印时去掉 docx-preview 的灰底外框。
// 3. 注入 @page + print-color-adjust —— 页面尺寸跟随文档、强制按原色打印。
// 4. 等待所有图片真正 load 完再 print()，否则可能打印出空白图位。
// 打印方向：
// - auto：跟随文档本身尺寸（默认，竖版文档打竖版、横版文档打横版）
// - portrait：强制竖版
// - landscape：强制横版（用于「Word 是竖版排版、但实际是横向五联货单」的场景，
//   会把 @page 宽高对调，并将渲染内容整体旋转 90° 铺满横向纸张）
export type PrintOrientation = 'auto' | 'portrait' | 'landscape';

export async function printDocxBlob(
  blob: Blob,
  orientation: PrintOrientation = 'auto',
  overlay?: PrintOverlay
): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '-9999px';
  iframe.style.width = '2000px';
  iframe.style.height = '3000px';
  iframe.style.opacity = '0';
  iframe.style.border = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1500);
  };

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印容器');

    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><title>打印</title></head><body></body></html>');
    doc.close();

    const mount = doc.body;
    await renderAsync(blob, mount, undefined, {
      className: 'docx',
      inWrapper: true,
      hideWrapperOnPrint: true, // 打印时隐藏灰色外框
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false, // 保留文档字体声明
      useBase64URL: true, // 图片内联，避免打印时签名图丢失
      experimental: true,
    });

    await injectHeaderFallback(blob, mount);
    // 电子印章叠加（先于 waitForImages，确保印章随文档一起等图加载）
    if (overlay && overlay.stamps.length > 0) {
      overlayStampsOnDoc(mount, overlay.stamps, overlay.config);
    }
    injectPrintStyles(doc, orientation);
    // 多 section 文档：隐藏只含页眉页脚的空页
    hideEmptySections(doc);
    await waitForImages(doc, 4000);
    // 压缩 Word 里被空段落撑大的「以下空白」占位行，避免它把页脚挤出 A4
    compactPlaceholderBlankRows(doc);
    // 根据页脚实际高度预留正文底部空间，避免绝对定位页脚压住正文
    reserveFooterSpace(doc);
    // 再给排版/字体一点稳定时间
    await new Promise((r) => setTimeout(r, 200));

    win.focus();
    win.print();
    cleanup();
  } catch (e: any) {
    cleanup();
    throw new Error('打印被环境拦截或渲染失败，请改用「下载 Word」后在本地打印。（' + (e?.message || e) + '）');
  }
}

// 多联打印：把同一份内容按联名列表连续打印多份，每份右上角叠加联名水印字样。
// docx 用 renderAsync 渲染，xlsx 传 htmlTable。两种入口共用一个 iframe，各联之间分页。
export async function printCopies(opts: {
  copies: string[]; // 联名，如 ['生产部','销售部','客户','财务部','开票']
  orientation?: PrintOrientation;
  docxBlob?: Blob;
  htmlTable?: string;
  overlay?: PrintOverlay; // 电子印章叠加（每联都盖）
}): Promise<void> {
  const { copies, orientation = 'auto', docxBlob, htmlTable, overlay } = opts;
  const labels = copies.length ? copies : [''];

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2000px;height:3000px;opacity:0;border:0;pointer-events:none;';
  document.body.appendChild(iframe);
  const cleanup = () => setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印容器');

    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><title>打印</title></head><body></body></html>');
    doc.close();

    for (let i = 0; i < labels.length; i++) {
      const page = doc.createElement('div');
      page.className = 'print-copy';
      page.style.cssText = `position:relative;${i < labels.length - 1 ? 'page-break-after:always;' : ''}`;

      if (labels[i]) {
        const badge = doc.createElement('div');
        badge.textContent = labels[i];
        badge.style.cssText = 'position:absolute;top:2mm;right:4mm;font-size:12px;color:#888;z-index:9;';
        page.appendChild(badge);
      }

      if (docxBlob) {
        const mount = doc.createElement('div');
        page.appendChild(mount);
        await renderAsync(docxBlob, mount, undefined, {
          className: 'docx', inWrapper: true, hideWrapperOnPrint: true, breakPages: true,
          ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, useBase64URL: true, experimental: true,
        });
        await injectHeaderFallback(docxBlob, mount);
        // 每联都盖同样的印章
        if (overlay && overlay.stamps.length > 0) {
          overlayStampsOnDoc(mount, overlay.stamps, overlay.config);
        }
      } else if (htmlTable) {
        page.insertAdjacentHTML('beforeend', htmlTable);
      }
      doc.body.appendChild(page);
    }

    injectPrintStyles(doc, orientation);
    // 多 section 文档：隐藏只含页眉页脚的空页
    hideEmptySections(doc);
    await waitForImages(doc, 4000);
    // 压缩 Word 里被空段落撑大的「以下空白」占位行，避免它把页脚挤出 A4
    compactPlaceholderBlankRows(doc);
    // 根据页脚实际高度预留正文底部空间，避免绝对定位页脚压住正文
    reserveFooterSpace(doc);
    await new Promise((r) => setTimeout(r, 250));
    win.focus();
    win.print();
    cleanup();
  } catch (e: any) {
    cleanup();
    throw new Error('多联打印失败，请改用「下载」后本地打印。（' + (e?.message || e) + '）');
  }
}

// 打印一段 HTML 表格（用于 xlsx 保真渲染结果）。
// orientation：landscape 时用 @page size landscape，让横版货单完整打印。
export async function printHtmlTable(tableHtml: string, orientation: PrintOrientation = 'auto'): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '-9999px';
  iframe.style.width = '2000px';
  iframe.style.height = '3000px';
  iframe.style.opacity = '0';
  iframe.style.border = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  const cleanup = () => {
    setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);
  };

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印容器');

    const sizeRule = orientation === 'landscape'
      ? '@page { size: landscape; margin: 8mm; }'
      : orientation === 'portrait'
      ? '@page { size: portrait; margin: 8mm; }'
      : '@page { margin: 8mm; }';

    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>打印</title><style>
      ${sizeRule}
      html, body { margin: 0; padding: 0; background: #fff; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      table { border-collapse: collapse; }
    </style></head><body>${tableHtml}</body></html>`);
    doc.close();

    await new Promise((r) => setTimeout(r, 200));
    win.focus();
    win.print();
    cleanup();
  } catch (e: any) {
    cleanup();
    throw new Error('打印被环境拦截，请改用「下载 Excel」后在本地打印。（' + (e?.message || e) + '）');
  }
}

// 注入打印专用样式：页面尺寸跟随文档、强制原色、去掉页边空白。
// orientation 控制打印方向：
// - auto：页面尺寸直接用文档 section 的宽高
// - portrait：用文档宽高，但保证较短边为宽（竖版）
// - landscape：把文档宽高对调（横版），并将内容整体旋转 90° 铺满横向纸张
function injectPrintStyles(doc: Document, orientation: PrintOrientation = 'auto') {
  // 读取首个渲染出的页面 section，取其真实宽高作为 @page size
  const section = doc.querySelector('section.docx') as HTMLElement | null;
  const pageRule = buildPageRule(section, orientation);
  let rotateCss = '';

  if (orientation === 'landscape' && section) {
    const wStr = section.style.width;
    const hStr = section.style.minHeight || section.style.height;
    const parseLen = (v: string): { num: number; unit: string } | null => {
      const m = /([\d.]+)\s*([a-z%]*)/i.exec(v || '');
      if (!m) return null;
      return { num: parseFloat(m[1]), unit: m[2] || 'px' };
    };
    const w = parseLen(wStr);
    const h = parseLen(hStr);
    if (w && h) {
      // 将渲染内容整体顺时针旋转 90°：原文档宽=w、高=h，
      // 旋转后需把原点移到右上角，占满新的横向纸张
      rotateCss = `
      @media print {
        .docx-wrapper { position: relative !important; }
        section.docx {
          transform: rotate(90deg);
          transform-origin: top left;
          /* 旋转后向右平移一个「文档高度」，使其落回可视区 */
          position: absolute;
          top: 0;
          left: ${h.num}${h.unit};
          min-height: ${h.num}${h.unit} !important;
          height: ${h.num}${h.unit} !important;
          width: ${w.num}${w.unit} !important;
        }
      }
        `;
    }
  }

  const style = doc.createElement('style');
  // 页脚绝对定位规则：仅非横向模式启用（landscape 旋转后 bottom 定位会错位到纸边缘）
  const footerAbsCss = orientation === 'landscape' ? '' : `
      section.docx {
        box-shadow: none !important;
        margin: 0 !important;
        min-height: auto !important;
        height: auto !important;
        box-sizing: border-box !important;
        position: relative !important;
        padding-bottom: 10px !important;
        overflow: visible !important;
        break-after: auto !important;
        page-break-after: auto !important;
      }
      section.docx > FOOTER,
      section.docx > footer,
      section.docx > sectionfooter,
      section.docx > SECTIONFOOTER {
        position: absolute !important;
        bottom: 10px !important;
        left: 0 !important;
        right: 0 !important;
        /* docx-preview 会给 footer 设置负 margin-bottom 与 min-height，
           绝对定位时若保留这些值会导致内容被 section 的 overflow:hidden 裁剪 */
        margin: 0 !important;
        min-height: auto !important;
        height: auto !important;
        box-sizing: border-box !important;
        overflow: visible !important;
      }
      /* docx-preview 把 footer 里的图片放进一个 width/height=0 的占位 div 里，
         打印时若保持 0x0，图片会向下溢出页面底部，反而被浏览器分页出一页空白。
         这里让该占位 div 随图片自然撑开，确保 footer 真实高度包含图片。 */
      section.docx > FOOTER div,
      section.docx > footer div,
      section.docx > sectionfooter div,
      section.docx > SECTIONFOOTER div {
        width: auto !important;
        height: auto !important;
      }
      section.docx > article {
        /* 默认留出 10px，实际会在 reserveFooterSpace 中按 footer 真实高度扩大 */
        padding-bottom: 10px !important;
      }`;
  style.textContent = `
    ${pageRule}
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    /* 强制按文档原色打印，防止背景色/浅色被浏览器淡化或丢弃 */
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    /* 页面 section 打印时去掉阴影与外边距，避免额外空白挤动版面。
       同时把 section 高度放开为 auto：docx-preview 会给每个 section 固定 A4 高度，
       内容不足一页时会被浏览器按固定高度分页，从而挤出只含页眉/页脚的空页。
       打印时让 section 随内容自然高度，由 @page size 控制纸张，即可消除空白页。
       页脚（FOOTER）改为绝对定位在底部、不参与文档流：
       内容刚好占满一页时，static 页脚会被分页算法挤到第二页；改为绝对定位后
       页脚固定在 section 底部，不再触发第二页。padding-bottom 10px 作为分页
       误差缓冲（内容高度与页面高度只差几像素时，留白吸收误差，避免空页）。
       为避免绝对定位的页脚压住正文底部的表格/签名，reserveFooterSpace 会
       根据页脚真实高度给 article 追加等高的 padding-bottom，让正文与页脚之间
       始终保留 10px 间隙。
       注意：这些规则放在顶层而非 @media print 中，因为 reserveFooterSpace
       在 screen 环境下测量，必须让测量时的布局与打印时一致。 */
    ${footerAbsCss}
    .docx-wrapper { background: #fff !important; padding: 0 !important; }
    /* 图片按其在文档中的尺寸打印，不被页面宽度压缩 */
    section.docx img { max-width: none; }
    /* Word 里用于占位的空段落，在 HTML 里会撑出额外高度，打印时折叠掉 */
    section.docx p:empty { margin: 0 !important; }
    /* 预览/打印时都隐藏被判定为空白的 section */
    section.docx.empty-page-hidden { display: none !important; }
    ${rotateCss}
  `;
  doc.head.appendChild(style);
}

// 根据 section 的 style 宽高与 orientation 生成 @page size 规则。
// 被 printDocxBlob 与 printPreviewElement 共用，确保纸张尺寸一致。
function buildPageRule(section: HTMLElement | null, orientation: PrintOrientation): string {
  const parseLen = (v: string): { num: number; unit: string } | null => {
    const m = /([\d.]+)\s*([a-z%]*)/i.exec(v || '');
    if (!m) return null;
    return { num: parseFloat(m[1]), unit: m[2] || 'px' };
  };

  if (!section) {
    return `@page { ${orientation === 'landscape' ? 'size: landscape; ' : ''}margin: 0; }`;
  }

  const wStr = section.style.width;
  const hStr = section.style.minHeight || section.style.height;
  const w = parseLen(wStr);
  const h = parseLen(hStr);

  if (!w || !h) {
    return `@page { ${orientation === 'landscape' ? 'size: landscape; ' : ''}margin: 0; }`;
  }

  let pw = wStr;
  let ph = hStr;
  if (orientation === 'landscape') {
    // 横向：纸张宽高对调，让长边作为宽度
    pw = hStr;
    ph = wStr;
  } else if (orientation === 'portrait') {
    // 竖版：保证宽 <= 高（若文档本身横版则对调）
    if (w.num > h.num) { pw = hStr; ph = wStr; }
  }
  return `@page { size: ${pw} ${ph}; margin: 0; }`;
}

// 根据 Word 页脚的真实高度，给正文 article 预留出「页脚高度 + 10px」的底部空间，
// 防止绝对定位的页脚覆盖正文最底部的表格/签名等内容。
// 注意：docx-preview 常把 footer 图片放进 0x0 的占位 div，导致 footer 元素高度
// 不能反映图片真实高度。这里取 footer 元素自身高度与其所有子元素最大下边缘的较大值。
// 由于 injectPrintStyles 把打印布局规则放在顶层（不在 @media print 中），
// 本函数在 screen 环境下测量到的就是实际打印布局，确保预留高度准确。
function reserveFooterSpace(doc: Document) {
  const sections = Array.from(doc.querySelectorAll('section.docx')) as HTMLElement[];
  sections.forEach((sec) => {
    const article = sec.querySelector(':scope > article') as HTMLElement | null;
    if (!article) return;
    // docx-preview 实际渲染的页脚标签是小写 footer（辅助树显示为 sectionfooter）
    const footer =
      (sec.querySelector(':scope > footer') as HTMLElement | null) ||
      (sec.querySelector(':scope > FOOTER') as HTMLElement | null) ||
      (sec.querySelector(':scope > sectionfooter') as HTMLElement | null) ||
      (sec.querySelector(':scope > SECTIONFOOTER') as HTMLElement | null);
    if (!footer) {
      article.style.setProperty('padding-bottom', '10px', 'important');
      return;
    }

    const measureFooterVisualHeight = () => {
      const fRect = footer.getBoundingClientRect();
      let maxBottom = fRect.bottom;
      footer.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom > maxBottom) maxBottom = r.bottom;
      });
      return Math.max(fRect.height, maxBottom - fRect.top);
    };

    // 先按 footer 真实高度预留基础 padding
    const h = measureFooterVisualHeight();
    let pb = Math.max(10, Math.ceil(h + 10));
    article.style.setProperty('padding-bottom', `${pb}px`, 'important');

    // 强制重排后检查正文内容底部与页脚顶部之间是否真的有 ≥10px 间隙。
    // 部分浏览器/字体布局会有 subpixel 误差，若不够则再追加 padding。
    for (let i = 0; i < 3; i++) {
      void article.offsetHeight;
      const fRect = footer.getBoundingClientRect();
      const artRect = article.getBoundingClientRect();
      const currentPb = parseFloat(getComputedStyle(article).paddingBottom || '0');
      const contentBottom = artRect.top + artRect.height - currentPb;
      const gap = fRect.top - contentBottom;
      if (gap >= 10) break;
      const need = Math.ceil(10 - gap);
      pb = Math.max(pb + need, Math.ceil(measureFooterVisualHeight() + 10));
      article.style.setProperty('padding-bottom', `${pb}px`, 'important');
    }
  });
}

// 把 Word 里常见的「以下空白」占位行压缩到最小高度。
// 这些行在 Word 里通常只有很小的高度，但 docx-preview 渲染时会因为空段落/行高被撑大，
// 在内容刚好接近一页时容易把页脚挤出 A4。压缩后保留文字，但不再占用大量空间。
function compactPlaceholderBlankRows(doc: Document) {
  const markers = ['以下空白'];
  doc.querySelectorAll('section.docx td, section.docx th').forEach((td) => {
    const text = (td.textContent || '').trim();
    if (!markers.some((m) => text.includes(m))) return;
    const row = td.closest('tr') as HTMLElement | null;
    if (!row) return;
    (td as HTMLElement).style.setProperty('padding', '0', 'important');
    (td as HTMLElement).style.setProperty('line-height', '1', 'important');
    (td as HTMLElement).style.setProperty('font-size', '9pt', 'important');
    (td as HTMLElement).style.setProperty('height', 'auto', 'important');
    (td as HTMLElement).style.setProperty('max-height', '14px', 'important');
    (td as HTMLElement).style.setProperty('overflow', 'hidden', 'important');
    row.style.setProperty('height', 'auto', 'important');
    // 删除单元格里除第一个以外的空段落，避免空 p 继续撑高
    let first = true;
    td.querySelectorAll('p').forEach((p) => {
      if (first) { first = false; return; }
      if (!(p.textContent || '').trim()) p.remove();
    });
  });
}

// 检测并隐藏空白 section（多 section 文档的兜底，避免只含页眉/页脚的空页被打印出来）。
// 返回隐藏的 section 数量。
export function hideEmptySections(doc: Document): number {
  const sections = Array.from(doc.querySelectorAll('section.docx')) as HTMLElement[];
  if (sections.length <= 1) return 0;

  let hidden = 0;
  sections.forEach((sec) => {
    // 排除页眉页脚后统计正文区域内容
    const header = sec.querySelector('.sectionheader');
    const footer = sec.querySelector('.sectionfooter');
    let text = sec.textContent || '';
    if (header) text = text.replace(header.textContent || '', '');
    if (footer) text = text.replace(footer.textContent || '', '');
    text = text.trim();

    const hasTable = sec.querySelector('table') !== null;
    const hasArticle = sec.querySelector('article') !== null;
    const articleText = (sec.querySelector('article')?.textContent || '').trim();

    // 空页判定：没有表格，正文区域几乎没有文字
    const isEmpty = !hasTable && articleText.length < 20 && text.length < 30;
    if (isEmpty) {
      sec.classList.add('empty-page-hidden');
      hidden++;
    }
  });
  return hidden;
}

export async function printPreviewElement(
  sourceEl: HTMLElement,
  orientation: PrintOrientation = 'auto'
): Promise<void> {
  const iframe = document.createElement('iframe');
  // iframe 尺寸按预览容器真实内容尺寸 + 余量，避免克隆过去后因视口过窄发生回流
  const viewW = sourceEl.scrollWidth || sourceEl.offsetWidth || 1200;
  const viewH = sourceEl.scrollHeight || sourceEl.offsetHeight || 1600;
  iframe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${viewW + 200}px;height:${viewH + 400}px;opacity:0;border:0;pointer-events:none;`;
  document.body.appendChild(iframe);

  const cleanup = () => setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印容器');

    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><title>打印</title></head><body></body></html>');
    doc.close();

    // 把父文档的样式表全部搬进 iframe，确保 docx-preview 的内置样式、
    // 项目自定义样式与预览环境完全一致，避免打印布局偏离预览。
    copyParentStyles(document, doc);

    // 克隆预览容器：保留 docx-preview 已渲染好的全部 DOM（含电子印章），
    // 但移除预览施加的缩放/过渡，让打印按 100% 尺寸输出。
    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.style.transform = '';
    clone.style.transformOrigin = '';
    clone.style.transition = '';
    // 保持克隆体在 iframe 中的尺寸与预览时一致，防止百分比/自适应元素重排
    clone.style.width = `${viewW}px`;
    clone.style.minWidth = `${viewW}px`;
    clone.style.minHeight = `${viewH}px`;
    doc.body.appendChild(clone);

    // 等待字体就绪（iframe 会重新加载字体），避免文字排版因回退字体而错位
    if (doc.fonts && doc.fonts.ready) {
      await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 1000))]);
    }

    // 注入基础打印样式：只调整纸张尺寸、颜色保真、去除灰底，
    // 不改动页眉/页脚/正文布局，确保输出与预览完全一致。
    const section = doc.querySelector('section.docx') as HTMLElement | null;
    const pageRule = buildPageRule(section, orientation);

    const style = doc.createElement('style');
    style.textContent = `
      ${pageRule}
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      .docx-wrapper { background: #fff !important; padding: 0 !important; margin: 0 !important; }
      section.docx { box-shadow: none !important; }
      section.docx img { max-width: none; }
      section.docx p:empty { margin: 0 !important; }
      section.docx.empty-page-hidden { display: none !important; }
    `;
    doc.head.appendChild(style);

    await waitForImages(doc, 4000);
    await new Promise((r) => setTimeout(r, 200));
    win.focus();
    win.print();
    cleanup();
  } catch (e: any) {
    cleanup();
    throw new Error('打印被环境拦截或渲染失败，请改用「下载 Word」后在本地打印。（' + (e?.message || e) + '）');
  }
}

// 把填充完成的 docx 上传服务端，由 LibreOffice 转成 PDF 后打印。
// PDF 的分页/页眉页脚由服务端的文档引擎计算，与 Word 打开模板完全一致，
// 不再受浏览器 HTML 分页算法影响（这是「打印输出与模板分页不一致」的根本解法）。
// 失败时抛出错误，由调用方决定是否降级为浏览器 HTML 打印。
export async function printDocxAsPdf(blob: Blob): Promise<void> {
  const res = await fetch('/api/print/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) {
    let msg = `服务端 PDF 转换失败（${res.status}）`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch (e) { /* 非 JSON 响应则用默认提示 */ }
    throw new Error(msg);
  }
  const pdfBlob = await res.blob();
  if (!pdfBlob || pdfBlob.size === 0) throw new Error('服务端返回的 PDF 为空');

  const url = URL.createObjectURL(pdfBlob);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1000px;height:1400px;opacity:0;border:0;pointer-events:none;';
  document.body.appendChild(iframe);

  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      URL.revokeObjectURL(url);
    }, 3000);
  };

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('无法创建打印容器');

    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>打印</title></head>
      <body style="margin:0;padding:0;background:#fff">
        <embed id="pdfDoc" src="${url}" type="application/pdf" style="width:100%;height:100%;border:0">
      </body></html>`);
    doc.close();

    // 等待 PDF 加载完成（embed 的 load 事件），超时兜底
    await new Promise<void>((resolve) => {
      const emb = doc.getElementById('pdfDoc') as HTMLElement | null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (emb) {
        emb.addEventListener('load', finish);
        emb.addEventListener('error', finish);
      }
      setTimeout(finish, 3000);
    });
    await new Promise((r) => setTimeout(r, 300));

    win.focus();
    win.print();
    cleanup();
  } catch (e: any) {
    cleanup();
    throw new Error('PDF 打印被环境拦截（' + (e?.message || e) + '）');
  }
}

// 将父文档中的 <link rel="stylesheet"> 与 <style> 复制到目标 iframe 文档，
// 保证打印 iframe 拥有与插件预览完全一致的 CSS 环境。
function copyParentStyles(sourceDoc: Document, targetDoc: Document) {
  const headTags: Element[] = [];
  sourceDoc.querySelectorAll('link[rel="stylesheet"]').forEach((el) => {
    if ((el as HTMLLinkElement).href) headTags.push(el);
  });
  sourceDoc.querySelectorAll('style').forEach((el) => headTags.push(el));

  headTags.forEach((el) => {
    try {
      if (el.tagName.toLowerCase() === 'link') {
        const link = targetDoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = (el as HTMLLinkElement).href;
        targetDoc.head.appendChild(link);
      } else {
        const style = targetDoc.createElement('style');
        style.textContent = el.textContent || '';
        targetDoc.head.appendChild(style);
      }
    } catch {
      // 忽略跨域或个别样式复制失败，不影响主流程
    }
  });
}

// 等待文档内所有 <img> 加载完成（或超时），避免打印出未加载的空图。
function waitForImages(doc: Document, timeoutMs: number): Promise<void> {
  const imgs = Array.from(doc.images || []);
  if (imgs.length === 0) return Promise.resolve();
  const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
  if (pending.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let done = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const tick = () => {
      done += 1;
      if (done >= pending.length) finish();
    };
    pending.forEach((img) => {
      img.addEventListener('load', tick, { once: true });
      img.addEventListener('error', tick, { once: true });
    });
    setTimeout(finish, timeoutMs); // 兜底超时，避免个别图卡住打印
  });
}
