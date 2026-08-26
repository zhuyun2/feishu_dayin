const fs = require('fs');
const path = require('path');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));
const PizZip = require(path.resolve(__dirname, '..', 'node_modules', 'pizzip'));

const ROOT = path.resolve(__dirname, '..');
const cache = {};
function compile(rel) {
  let source = fs.readFileSync(path.resolve(ROOT, 'src', rel), 'utf8');
  source = source.replace(/import\s+type\s+[\s\S]*?;/g, '');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
}
function load(rel) {
  if (cache[rel]) return cache[rel];
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compile(rel))(mod, mod.exports, (id) => {
    if (id === 'pizzip') return PizZip;
    if (id === 'docxtemplater') return require(path.resolve(ROOT, 'node_modules', 'docxtemplater'));
    if (id.startsWith('./')) {
      const dep = path.normalize(path.join(path.dirname(rel), `${id}.ts`)).replace(/\\/g, '/');
      return load(dep);
    }
    return require(id);
  });
  cache[rel] = mod.exports;
  return mod.exports;
}

(async () => {
  const engine = load('services/docxFill.ts');
  const file = path.resolve(ROOT, 'templates', 'tblR4JPa9dyagRA6', '广东迪美.docx');
  const buffer = fs.readFileSync(file);
  const rows = Array.from({ length: 8 }, (_, i) => ({
    客户物料编码: `C${i + 1}`, 出货名: `产品${i + 1}`, 包装: '25kg/桶',
    单位: 'kg', 数量: i + 1, 产品单价: 2, 产品总价: (i + 1) * 2, 产品批号: `B${i + 1}`,
  }));
  const blob = engine.fillTemplate(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    { 品名: rows }
  );
  const zip = new PizZip(await blob.arrayBuffer());
  const xml = zip.file('word/document.xml').asText();
  const pages = xml.split(/<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/);
  const rowCounts = pages.map((page) => (page.match(/<w:tr[ >]/g) || []).length);
  if (pages.length !== 2) throw new Error(`8 条明细应生成 2 页，实际 ${pages.length} 页`);
  if (rowCounts[0] !== rowCounts[1]) throw new Error(`第二页未补足空行：表格行数 ${rowCounts.join('/')}`);
  if (rowCounts[0] !== 14) throw new Error(`每页应保持模板 14 个表格行，实际 ${rowCounts.join('/')}`);
  console.log('结果：3 通过，0 失败');
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
