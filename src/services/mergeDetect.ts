import PizZip from 'pizzip';
import type { MergeHit } from '../types';
import { scanMerges, scanLoopFields } from './mergeField';

// ============================================================================
// 从模板文件里检测复合占位符 {{A}{B}}
// ----------------------------------------------------------------------------
// 扫描范围必须与填充引擎实际改写的范围严格一致，否则会出现
// 「界面提示检测到合并字段，但打印出来还是原始的 {{...}}」甚至渲染报错：
//   - docx：word/document.xml + word/header*.xml + word/footer*.xml
//     （docxtemplater 会一并渲染页眉页脚，docxFill 也对这些 part 一起改写）
//   - xlsx：xl/sharedStrings.xml + 第一个 worksheet
//     （xlsxFill 只内联并改写第一个 sheet 的共享字符串）
// ============================================================================

// 与 xlsxFill 选取工作表的口径保持一致
function firstSheetPath(zip: PizZip): string | undefined {
  return Object.keys(zip.files).find((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
}

function collectXmlParts(zip: PizZip, name: string): string[] {
  const parts: string[] = [];
  const push = (path: string | undefined) => {
    if (!path) return;
    const file = zip.file(path);
    if (file) parts.push(file.asText());
  };

  if (/\.xlsx$/i.test(name)) {
    push('xl/sharedStrings.xml');
    push(firstSheetPath(zip));
  } else {
    Object.keys(zip.files)
      .filter((p) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(p))
      .forEach(push);
  }
  return parts;
}

export function detectTemplateMerges(buffer: ArrayBuffer, name: string): MergeHit[] {
  let parts: string[];
  try {
    parts = collectXmlParts(new PizZip(buffer), name);
  } catch (e) {
    return [];
  }

  const seen = new Map<string, MergeHit>();
  for (const xml of parts) {
    for (const hit of scanMerges(xml)) {
      if (!seen.has(hit.signature)) seen.set(hit.signature, hit);
    }
  }
  return Array.from(seen.values());
}

// ============================================================================
// 从模板文件里检测「被用作循环的字段名」（{#字段} … {/字段}）
// ----------------------------------------------------------------------------
// 数据层拿到这个清单后，才会把「子表内的关联字段」递归展开成数组，
// 从而支持两层嵌套循环；模板里没写成循环的嵌套关联字段仍按汇总文本输出。
// 扫描范围与 detectTemplateMerges 一致（正文 + 页眉页脚 / 共享字符串 + 首个工作表）。
// ============================================================================
export function detectTemplateLoops(buffer: ArrayBuffer, name: string): string[] {
  let parts: string[];
  try {
    parts = collectXmlParts(new PizZip(buffer), name);
  } catch (e) {
    return [];
  }

  const names = new Set<string>();
  for (const xml of parts) {
    for (const field of scanLoopFields(xml)) names.add(field);
  }
  return Array.from(names);
}
