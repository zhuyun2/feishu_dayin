/* xlsx 填充引擎自测：对真实货单模板验证占位符、循环、求和、结构完整性。
 * 运行：node scripts/test-xlsx.cjs
 * 注意：本文件用 CommonJS，直接内联复制 xlsxFill 的核心逻辑做黑盒验证不现实，
 * 因此改为通过 ts 编译产物思路——这里用 require 加载 pizzip 直接跑引擎的等价实现。
 * 为避免 TS/ESM 差异，本测试通过 esbuild 动态转译 xlsxFill.ts 后执行。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PizZip = require(path.resolve(ROOT, 'node_modules', 'pizzip'));

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  \u2713', name); }
  else { fail++; console.log('  \u2717', name); }
}

// 用 TypeScript 编译器把 xlsxFill.ts 转成 CJS 再 require（不依赖 esbuild）
function loadEngine() {
  const ts = require(path.resolve(ROOT, 'node_modules', 'typescript'));
  const compile = (rel) => {
    let source = fs.readFileSync(path.resolve(ROOT, 'src', rel), 'utf8');
    source = source.replace(/import\s+type\s+[\s\S]*?;/g, '');
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText;
  };
  // 先编译依赖 money，再编译 xlsxFill；用一个 require 解析 './money' 到已编译产物
  const moneyMod = { exports: {} };
  new Function('module', 'exports', 'require', compile('services/money.ts'))(moneyMod, moneyMod.exports, require);

  const m = { exports: {} };
  const req = (id) => {
    if (id === 'pizzip') return PizZip;
    if (id === './money') return moneyMod.exports;
    return require(id);
  };
  new Function('module', 'exports', 'require', compile('services/xlsxFill.ts'))(m, m.exports, req);
  return m.exports;
}

function loadRenderer() {
  const ts = require(path.resolve(ROOT, 'node_modules', 'typescript'));
  const source = fs.readFileSync(path.resolve(ROOT, 'src', 'services', 'xlsxRender.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', output)(m, m.exports, require);
  return m.exports;
}

const TEMPLATE = path.resolve(ROOT, 'templates', '迪新货单.xlsx');
const ONE_ROW_TEMPLATE = path.resolve(ROOT, 'templates', 'tblR4JPa9dyagRA6', '迪新货单（1行）.xlsx');

function main() {
  const eng = loadEngine();
  const buf = fs.readFileSync(TEMPLATE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  // 读原始共享字符串
  const zip0 = new PizZip(ab);
  const ss = eng.parseSharedStrings(zip0.file('xl/sharedStrings.xml').asText());

  console.log('测试1：占位符提取');
  const ph = eng.extractPlaceholders(ss);
  assert('包含 客户名称', ph.includes('客户名称'));
  assert('包含 品名(循环)', ph.includes('品名'));
  assert('包含 合计金额', ph.includes('合计金额'));

  console.log('测试2：普通占位符填充');
  const data = {
    发货时间: '2026-07-30',
    客户名称: '测试客户<A&B>',
    合同单号: 'HT-001',
    '内部货单编号（自动赋码）': 'DX20260730',
    品名: [
      { 出货名: '苯氧乙醇', 数量: '10', 产品单价: '25', 产品总价: '250', 单位: 'kg' },
      { 出货名: '对羟基苯乙酮', 数量: '5', 产品单价: '40', 产品总价: '200', 单位: 'kg' },
      { 出货名: '乙基己基甘油', 数量: '3', 产品单价: '100', 产品总价: '300', 单位: 'kg' },
    ],
  };
  const blob = eng.fillXlsx(ab, { ...data });
  assert('返回 Blob 且有内容', blob && blob.size > 0);

  // 把 blob 转回 buffer 重新解析
  return blob.arrayBuffer().then(async (filledAb) => {
    const z = new PizZip(filledAb);
    const sheetName = Object.keys(z.files).find((n) => /worksheets\/sheet\d+\.xml$/.test(n));
    const sheet = z.file(sheetName).asText();

    assert('客户名称已填且 XSS 转义', sheet.includes('测试客户&lt;A&amp;B&gt;'));
    assert('单号已填', sheet.includes('DX20260730'));
    assert('循环标记已清除', !sheet.includes('{#品名}') && !sheet.includes('{/品名}'));

    console.log('测试3：明细循环 3 行');
    assert('出货名1 苯氧乙醇', sheet.includes('苯氧乙醇'));
    assert('出货名2 对羟基苯乙酮', sheet.includes('对羟基苯乙酮'));
    assert('出货名3 乙基己基甘油', sheet.includes('乙基己基甘油'));
    const mergeXml = (sheet.match(/<mergeCells[\s\S]*?<\/mergeCells>/) || [''])[0];
    assert('复制的第2条明细保留货品名称合并单元格', mergeXml.includes('ref="B6:C6"'));
    assert('复制的第2条明细保留单价合并单元格', mergeXml.includes('ref="G6:H6"'));
    assert('合计行固定在第 10 行', mergeXml.includes('ref="A10:E10"'));
    assert('合并区数量与标准 5 行模板一致', mergeXml.includes('count="21"'));
    assert('3 条明细仍保留标准 14 行版式', /<dimension ref="A1:J14"\s*\/>/.test(sheet));

    console.log('测试4：自动求和');
    assert('合计数量=18', sheet.includes('>18<') || sheet.includes('18</t>'));
    assert('合计金额=750', sheet.includes('>750<') || sheet.includes('750</t>'));

    console.log('测试5：结构完整（可被 PizZip 重新打开且含关键部件）');
    assert('含 workbook.xml', !!z.file('xl/workbook.xml'));
    assert('含 sheetData', sheet.includes('<sheetData>') && sheet.includes('</sheetData>'));
    assert('无残留占位符', !/\{[^{}]+\}/.test(sheet));

    console.log('测试6：0 条明细不报错');
    const blob0 = eng.fillXlsx(ab, { 客户名称: '空单', 品名: [] });
    assert('空明细返回 Blob', blob0 && blob0.size > 0);

    console.log('测试7：10 条明细按模板 5 行容量分页');
    const tenRows = Array.from({ length: 10 }, (_, i) => ({
      出货名: `分页产品${i + 1}`, 数量: 1, 产品单价: 2, 产品总价: 2, 单位: 'kg',
    }));
    const pagedBlob = eng.fillXlsx(ab, { 客户名称: '分页客户', 品名: tenRows });
    const pagedZip = new PizZip(await pagedBlob.arrayBuffer());
    const pagedSheet = pagedZip.file(sheetName).asText();
    const rowIds = Array.from(pagedSheet.matchAll(/<row r="(\d+)"/g), (m) => Number(m[1]));
    assert('两页共 28 行且行号连续', rowIds.length === 28 && rowIds.every((r, i) => r === i + 1));
    assert('工作表范围为 A1:J28', /<dimension ref="A1:J28"\s*\/>/.test(pagedSheet));
    assert('第 14 行后存在手动分页符', /<rowBreaks[^>]*>.*<brk id="14"[^>]*man="1"\/>.*<\/rowBreaks>/.test(pagedSheet));
    assert('分页符位于 pageSetup 之后，符合 Excel XML 顺序', pagedSheet.indexOf('<rowBreaks') > pagedSheet.indexOf('<pageSetup'));
    assert('第二页包含完整表头', (pagedSheet.match(/分页客户/g) || []).length === 2);
    assert('两页明细合计 10 条且无循环标记', tenRows.every((_, i) => pagedSheet.includes(`分页产品${i + 1}`)) && !/\{[#/]品名\}/.test(pagedSheet));
    const page1Total = (pagedSheet.match(/<row r="10"[\s\S]*?<\/row>/) || [''])[0];
    const page2Total = (pagedSheet.match(/<row r="24"[\s\S]*?<\/row>/) || [''])[0];
    assert('第一页合计数量只统计当前 5 条', /<t[^>]*>5<\/t>/.test(page1Total));
    assert('第二页合计数量只统计当前 5 条', /<t[^>]*>5<\/t>/.test(page2Total));

    console.log('测试8：HTML 预览按分页符拆为两张表');
    const html = await loadRenderer().renderXlsxToHtml(pagedBlob);
    assert('HTML 含两个 table', (html.match(/<table\b/g) || []).length === 2);
    assert('第一页设置打印后分页', html.includes('break-after:page'));

    console.log('测试9：1 行模板也必须扩展为标准 5 行');
    const oneRowBuf = fs.readFileSync(ONE_ROW_TEMPLATE);
    const oneRowAb = oneRowBuf.buffer.slice(oneRowBuf.byteOffset, oneRowBuf.byteOffset + oneRowBuf.byteLength);
    const threeRows = tenRows.slice(0, 3);
    const normalizedBlob = eng.fillXlsx(oneRowAb, { 客户名称: '标准五行', 品名: threeRows });
    const normalizedZip = new PizZip(await normalizedBlob.arrayBuffer());
    const normalizedSheetName = Object.keys(normalizedZip.files).find((n) => /worksheets\/sheet\d+\.xml$/.test(n));
    const normalizedSheet = normalizedZip.file(normalizedSheetName).asText();
    const normalizedRowIds = Array.from(normalizedSheet.matchAll(/<row r="(\d+)"/g), (m) => Number(m[1]));
    assert('3 条明细只生成一张 14 行货单', normalizedRowIds.length === 14 && normalizedRowIds.every((r, i) => r === i + 1));
    assert('1 行模板的一页没有分页符', !normalizedSheet.includes('<rowBreaks'));
    assert('明细区固定保留第 5-9 行', [5, 6, 7, 8, 9].every((r) => normalizedSheet.includes(`<row r="${r}"`)));

    const sixRowsBlob = eng.fillXlsx(oneRowAb, { 客户名称: '标准五行', 品名: tenRows.slice(0, 6) });
    const sixRowsZip = new PizZip(await sixRowsBlob.arrayBuffer());
    const sixRowsSheet = sixRowsZip.file(normalizedSheetName).asText();
    const sixRowIds = Array.from(sixRowsSheet.matchAll(/<row r="(\d+)"/g), (m) => Number(m[1]));
    assert('6 条明细生成两张 14 行货单', sixRowIds.length === 28 && sixRowIds.every((r, i) => r === i + 1));
    assert('第二页从第 15 行开始', /<brk id="14"[^>]*man="1"\/>/.test(sixRowsSheet));
    const oneRowHtml = await loadRenderer().renderXlsxToHtml(sixRowsBlob);
    assert('1 行模板生成结果可被 ExcelJS 读取', oneRowHtml.includes('分页产品1'));
    assert('1 行模板的 HTML 预览为两页', (oneRowHtml.match(/<table\b/g) || []).length === 2);

    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
  });
}

main();
