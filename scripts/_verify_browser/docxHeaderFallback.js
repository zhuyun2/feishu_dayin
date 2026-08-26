import PizZip from 'pizzip';
/**
 * 页眉浮动元素兜底渲染。
 *
 * docx-preview 对 Word 页眉中的浮动对象（wrapNone / behindDoc 图片、wps:wsp 文本框）
 * 支持不完整，导致 Logo、公司抬头丢失或错位。本模块解析 word/headerN.xml 中的
 * wp:anchor，把需要的浮动元素以 absolute 子元素注入到 docx-preview 渲染出的
 * section.docx 顶部，并尽量按 OOXML 语义定位。
 *
 * 当前策略：
 * - 图片：只注入 behindDoc="1" 的图片（作为背景/水印类 Logo）。如果 docx-preview
 *   已经在 <header> 中渲染了同名图片，则跳过注入，避免重复与错位。
 * - 文本框：wps:wsp 默认不渲染。如果 docx-preview 已经通过 VML/SVG 渲染出相同文本，
 *   则跳过注入，避免重影。
 * - behindDoc="1" 的元素用正值低 z-index（1），避免被白色页面背景盖住。
 */
const EMU_PER_PX = 9525;
// 常用命名空间
const NS = {
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
    wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
    w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
/** 测试导出：解析 docx 中所有 header 的 anchor 信息 */
export async function __test_parseHeader(docxBlob) {
    const buf = await docxBlob.arrayBuffer();
    const zip = new PizZip(buf);
    const headerPaths = Object.keys(zip.files).filter((p) => /^word\/header\d+\.xml$/i.test(p));
    const out = [];
    for (const path of headerPaths) {
        const items = parseHeader(zip, path);
        for (const it of items) {
            out.push({ ...it, path });
        }
    }
    return out;
}
export async function injectHeaderFallback(docxBlob, root, options = {}) {
    const { debugHighlight = false } = options;
    const buf = await docxBlob.arrayBuffer();
    const zip = new PizZip(buf);
    const headerPaths = Object.keys(zip.files).filter((p) => /^word\/header\d+\.xml$/i.test(p));
    if (headerPaths.length === 0)
        return;
    const headers = headerPaths
        .map((p) => parseHeader(zip, p))
        .filter((h) => h.length > 0);
    if (headers.length === 0)
        return;
    const sections = Array.from(root.querySelectorAll('section.docx'));
    sections.forEach((section, idx) => {
        const items = headers[Math.min(idx, headers.length - 1)];
        const ctx = buildSectionContext(section, root);
        injectIntoSection(section, ctx, items, options.debugHighlight);
    });
}
// ---------- 解压与解析 ----------
function parseHeader(zip, headerPath) {
    const xmlText = zip.file(headerPath)?.asText();
    if (!xmlText)
        return [];
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const anchors = Array.from(doc.getElementsByTagNameNS(NS.wp, 'anchor'));
    if (anchors.length === 0)
        return [];
    const rels = loadRels(zip, headerPath);
    const items = [];
    for (const anchor of anchors) {
        const item = parseAnchor(anchor, zip, rels);
        if (item)
            items.push(item);
    }
    return items;
}
function loadRels(zip, headerPath) {
    const relsPath = `word/_rels/${headerPath.replace('word/', '')}.rels`;
    const text = zip.file(relsPath)?.asText();
    if (!text)
        return {};
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const map = {};
    for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target)
            map[id] = target.replace(/^\//, '');
    }
    return map;
}
function parseAnchor(anchor, zip, rels) {
    const behindDoc = anchor.getAttribute('behindDoc') === '1';
    // extent 尺寸
    const extent = anchor.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const cx = parseEmu(extent?.getAttribute('cx'));
    const cy = parseEmu(extent?.getAttribute('cy'));
    if (!cx || !cy)
        return null;
    // 定位
    const pos = parsePosition(anchor);
    // 图片
    const blip = anchor.getElementsByTagNameNS(NS.a, 'blip')[0];
    if (blip) {
        // 只兜底 behindDoc=1 的图片；前景图 docx-preview 通常能正确渲染
        if (!behindDoc)
            return null;
        const embed = blip.getAttributeNS(NS.r, 'embed');
        if (!embed)
            return null;
        const target = rels[embed];
        if (!target)
            return null;
        const mediaPath = `word/${target.replace(/^word\//, '')}`;
        const file = zip.file(mediaPath);
        if (!file)
            return null;
        const src = dataUrlFromFile(file, mediaPath);
        if (!src)
            return null;
        return {
            type: 'image',
            ...pos,
            width: cx / EMU_PER_PX,
            height: cy / EMU_PER_PX,
            zIndex: behindDoc ? 1 : 10,
            src,
        };
    }
    // 文本框 wps:wsp
    const wsp = anchor.getElementsByTagNameNS(NS.wps, 'wsp')[0];
    if (wsp) {
        const paragraphs = collectParagraphs(wsp);
        const text = paragraphs.map((p) => p.text).join('\n');
        if (!text.trim())
            return null;
        const padding = parseBodyPr(wsp);
        const firstFontSize = paragraphs[0]?.fontSizePt;
        return {
            type: 'textbox',
            ...pos,
            width: cx / EMU_PER_PX,
            height: cy / EMU_PER_PX,
            zIndex: behindDoc ? 1 : 10,
            text,
            paragraphs,
            padding,
            fontSizePt: firstFontSize,
        };
    }
    return null;
}
function parseEmu(v) {
    const n = parseInt(v || '0', 10);
    return Number.isFinite(n) ? n : 0;
}
function parsePosition(anchor) {
    const posH = anchor.getElementsByTagNameNS(NS.wp, 'positionH')[0];
    const posV = anchor.getElementsByTagNameNS(NS.wp, 'positionV')[0];
    const relH = posH?.getAttribute('relativeFrom') || 'column';
    const relV = posV?.getAttribute('relativeFrom') || 'paragraph';
    const offsetH = parseEmu(posH?.getElementsByTagNameNS(NS.wp, 'posOffset')[0]?.textContent || '0');
    const offsetV = parseEmu(posV?.getElementsByTagNameNS(NS.wp, 'posOffset')[0]?.textContent || '0');
    return {
        relativeH: relH,
        relativeV: relV,
        offsetH,
        offsetV,
    };
}
function dataUrlFromFile(file, path) {
    try {
        const ext = path.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'png'
            ? 'image/png'
            : ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : ext === 'gif'
                    ? 'image/gif'
                    : ext === 'svg'
                        ? 'image/svg+xml'
                        : 'image/png';
        let b64 = '';
        if (typeof file.asBase64 === 'function') {
            b64 = file.asBase64();
        }
        else if (typeof file.asUint8Array === 'function') {
            const arr = file.asUint8Array();
            b64 = uint8ToBase64(arr);
        }
        else if (typeof file.asArrayBuffer === 'function') {
            b64 = uint8ToBase64(new Uint8Array(file.asArrayBuffer()));
        }
        else if (typeof file.asBinary === 'function') {
            b64 = btoa(file.asBinary());
        }
        if (!b64)
            return null;
        return `data:${mime};base64,${b64}`;
    }
    catch {
        return null;
    }
}
function uint8ToBase64(arr) {
    const chunk = 0x8000;
    let parts = [];
    for (let i = 0; i < arr.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + chunk))));
    }
    return btoa(parts.join(''));
}
function isInsideFallback(el) {
    let node = el;
    while (node) {
        if (node.tagName === 'mc:Fallback')
            return true;
        node = node.parentElement;
    }
    return false;
}
function collectParagraphs(el) {
    // 优先取 wps:txbx 里的段落；若不存在则取整个元素
    const txbx = el.getElementsByTagNameNS(NS.wps, 'txbx')[0] || el;
    const pEls = Array.from(txbx.getElementsByTagNameNS(NS.w, 'p'));
    const paragraphs = [];
    for (const p of pEls) {
        // 跳过 Word 兼容性 VML fallback 中的重复文本
        if (isInsideFallback(p))
            continue;
        const texts = Array.from(p.getElementsByTagNameNS(NS.w, 't'));
        const line = texts.map((t) => t.textContent || '').join('');
        if (!line.trim())
            continue;
        paragraphs.push({
            text: line,
            fontSizePt: parseParagraphFontSize(p),
            bold: !!p.getElementsByTagNameNS(NS.w, 'b')[0],
        });
    }
    return paragraphs;
}
function parseParagraphFontSize(p) {
    // 优先取 run 属性里的 sz，再取段落属性里的 sz
    const sz = p.getElementsByTagNameNS(NS.w, 'sz')[0] ||
        p.getElementsByTagNameNS(NS.w, 'rPr')[0]?.getElementsByTagNameNS(NS.w, 'sz')[0];
    if (!sz)
        return undefined;
    const v = parseInt(sz.getAttribute('w:val') || sz.getAttribute('val') || '0', 10);
    return v > 0 ? v / 2 : undefined; // half-points -> points
}
function parseBodyPr(wsp) {
    const bodyPr = wsp.getElementsByTagNameNS(NS.wps, 'bodyPr')[0];
    const parseIns = (attr) => {
        const v = bodyPr?.getAttribute(attr);
        return v ? parseInt(v, 10) / EMU_PER_PX : 0;
    };
    return {
        left: parseIns('lIns'),
        top: parseIns('tIns'),
        right: parseIns('rIns'),
        bottom: parseIns('bIns'),
    };
}
function parseFontSize(wsp) {
    const sz = wsp.getElementsByTagNameNS(NS.w, 'sz')[0];
    if (!sz)
        return undefined;
    const v = parseInt(sz.getAttribute('w:val') || sz.getAttribute('val') || '0', 10);
    return v > 0 ? v / 2 : undefined; // half-points -> points
}
// ---------- 注入 ----------
function buildSectionContext(section, root) {
    const style = getComputedStyle(section);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const scale = detectScale(section);
    return { section, paddingLeft, paddingTop, scale };
}
function detectScale(el) {
    const rect = el.getBoundingClientRect();
    const layoutW = el.offsetWidth;
    if (layoutW && rect.width)
        return rect.width / layoutW;
    const layoutH = el.offsetHeight;
    if (layoutH && rect.height)
        return rect.height / layoutH;
    return 1;
}
function injectIntoSection(section, ctx, items, debugHighlight = false) {
    // 确保 section 能作为 absolute 定位上下文
    if (getComputedStyle(section).position === 'static') {
        section.style.position = 'relative';
    }
    const headerRoot = section.querySelector('header');
    const layer = document.createElement('div');
    layer.className = 'docx-header-fallback';
    layer.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:1;';
    const injectedImageSrcs = new Set();
    for (const item of items) {
        const pos = resolvePosition(item, ctx);
        if (!pos)
            continue;
        if (item.type === 'image' && item.src) {
            const img = document.createElement('img');
            img.src = item.src;
            img.dataset.fallbackType = 'image';
            img.style.cssText =
                `position:absolute;left:${pos.left}px;top:${pos.top}px;` +
                    `width:${item.width}px;height:${item.height}px;` +
                    `z-index:${item.zIndex};pointer-events:none;` +
                    (debugHighlight ? `border:2px dashed rgba(255,0,0,0.6);background:rgba(255,0,0,0.08);` : '');
            layer.appendChild(img);
            injectedImageSrcs.add(item.src);
        }
        else if (item.type === 'textbox') {
            const paragraphs = item.paragraphs && item.paragraphs.length > 0 ? item.paragraphs : [{ text: item.text || '' }];
            const div = document.createElement('div');
            const pad = item.padding || { left: 0, top: 0, right: 0, bottom: 0 };
            div.dataset.fallbackType = 'textbox';
            // bodyPr anchor="t" 表示文本从 shape 顶部开始；段落自身 pPr jc="center" 已负责水平居中
            div.style.cssText =
                `position:absolute;left:${pos.left}px;top:${pos.top}px;` +
                    `width:${item.width}px;height:${item.height}px;` +
                    `box-sizing:border-box;` +
                    `padding:${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px;` +
                    `z-index:${item.zIndex};pointer-events:none;` +
                    `display:flex;flex-direction:column;justify-content:flex-start;align-items:center;text-align:center;overflow:visible;` +
                    (debugHighlight ? `border:2px dashed rgba(0,128,255,0.6);background:rgba(0,128,255,0.08);` : '');
            for (const p of paragraphs) {
                const pDiv = document.createElement('div');
                pDiv.style.cssText = 'white-space:pre-wrap;word-break:break-word;width:100%;';
                if (p.fontSizePt) {
                    pDiv.style.fontSize = `${p.fontSizePt}pt`;
                }
                if (p.bold) {
                    pDiv.style.fontWeight = 'bold';
                }
                pDiv.textContent = p.text;
                div.appendChild(pDiv);
            }
            layer.appendChild(div);
        }
    }
    if (layer.childNodes.length === 0)
        return;
    // 隐藏 docx-preview 原生渲染到 <header> 中的浮动对象，避免与 fallback 重影/错位
    hideNativeHeaderFloats(headerRoot);
    section.appendChild(layer);
    if (injectedImageSrcs.size > 0) {
        suppressDuplicateHeaderImages(section, injectedImageSrcs);
    }
}
function isTextBoxRendered(headerText, text) {
    const fingerprint = text.trim().replace(/\s+/g, '').slice(0, 20);
    if (!fingerprint)
        return false;
    return headerText.includes(fingerprint);
}
function resolvePosition(item, ctx) {
    // docx-preview 对页眉浮动对象的定位与 Word 差异很大，原生渲染经常出现 Logo/文本框重叠。
    // 这里采用保守策略：把 OOXML 中的 offset 直接映射到 section 的 padding edge。
    // 对 column/margin/paragraph 均以 padding edge 为基准，这样计算出的位置与 Word 打印效果接近。
    const offsetH = item.offsetH / EMU_PER_PX;
    const offsetV = item.offsetV / EMU_PER_PX;
    const baseH = item.relativeH === 'page' ? 0 : ctx.paddingLeft;
    const baseV = item.relativeV === 'page' ? 0 : ctx.paddingTop;
    return {
        left: baseH + offsetH - ctx.paddingLeft,
        top: baseV + offsetV - ctx.paddingTop,
    };
}
function hideNativeHeaderFloats(headerRoot) {
    if (!headerRoot)
        return;
    // docx-preview 会把 floating 文本框渲染成绝对定位 SVG，把 floating 图片渲染成 img。
    // 这些原生元素位置经常错误，直接隐藏，由 fallback 完全接管。
    const selectors = [
        'svg',
        'img',
        'foreignObject',
        '.vml-shape',
        '[style*="position:absolute"]',
        '[style*="position: absolute"]',
    ];
    for (const sel of selectors) {
        for (const el of Array.from(headerRoot.querySelectorAll(sel))) {
            const htmlEl = el;
            try {
                htmlEl.style.display = 'none';
            }
            catch {
                // ignore
            }
        }
    }
}
function suppressDuplicateHeaderImages(section, srcSet) {
    // docx-preview 原生的 behindDoc=1 图片可能被渲染到 <header> 中并错位，
    // 用 src 匹配隐藏同名图片。
    const imgs = Array.from(section.querySelectorAll('header img, .docx-header img'));
    for (const img of imgs) {
        try {
            if (srcSet.has(img.src)) {
                img.style.display = 'none';
            }
        }
        catch {
            // ignore cross-origin/style access issues
        }
    }
}
