const path = require('path');
const fs = require('fs');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'previewBlob.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', output)(mod, mod.exports, require);

const xlsxBlob = new Blob(['xlsx']);
const result = { templateName: '旧模板.xlsx', blob: xlsxBlob };

if (mod.exports.currentPreviewBlob(result, '新模板.docx') !== null) {
  throw new Error('切换模板格式时仍把旧 Blob 交给新预览器');
}
if (mod.exports.currentPreviewBlob(result, '旧模板.xlsx') !== xlsxBlob) {
  throw new Error('当前模板的 Blob 不应被过滤');
}
console.log('结果：2 通过，0 失败');
