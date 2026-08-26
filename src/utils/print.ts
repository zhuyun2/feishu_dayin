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
    await waitForImages(doc, 4000);
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
    await waitForImages(doc, 4000);
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
  let pageRule = '';
  let rotateCss = '';

  const parseLen = (v: string): { num: number; unit: string } | null => {
    const m = /([\d.]+)\s*([a-z%]*)/i.exec(v || '');
    if (!m) return null;
    return { num: parseFloat(m[1]), unit: m[2] || 'px' };
  };

  if (section) {
    const wStr = section.style.width; // docx-preview 写入的是带单位的值，如 "595.3pt"
    const hStr = section.style.minHeight || section.style.height;
    const w = parseLen(wStr);
    const h = parseLen(hStr);

    if (w && h) {
      // 文档原始纸张宽高
      let pw = wStr;
      let ph = hStr;

      if (orientation === 'landscape') {
        // 横向：纸张宽高对调，让长边作为宽度
        pw = hStr;
        ph = wStr;
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
            }
          }
        `;
      } else if (orientation === 'portrait') {
        // 竖版：保证宽 <= 高（若文档本身横版则对调）
        if (w.num > h.num) { pw = hStr; ph = wStr; }
      }
      pageRule = `@page { size: ${pw} ${ph}; margin: 0; }`;
    } else {
      pageRule = `@page { ${orientation === 'landscape' ? 'size: landscape; ' : ''}margin: 0; }`;
    }
  } else {
    pageRule = `@page { ${orientation === 'landscape' ? 'size: landscape; ' : ''}margin: 0; }`;
  }

  const style = doc.createElement('style');
  style.textContent = `
    ${pageRule}
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    /* 强制按文档原色打印，防止背景色/浅色被浏览器淡化或丢弃 */
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    /* 页面 section 打印时去掉阴影与外边距，避免额外空白挤动版面 */
    @media print {
      section.docx { box-shadow: none !important; margin: 0 !important; }
      .docx-wrapper { background: #fff !important; padding: 0 !important; }
      /* 图片按其在文档中的尺寸打印，不被页面宽度压缩 */
      section.docx img { max-width: none; }
    }
    ${rotateCss}
  `;
  doc.head.appendChild(style);
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
