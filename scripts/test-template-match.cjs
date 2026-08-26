const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/templateMatch.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);

let failed = 0;
function assert(name, condition) {
  if (condition) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name); }
}

const templates = [
  { name: '迪新货单.xlsx', size: 1, mtime: 1 },
  { name: '迪新货单-备用.docx', size: 1, mtime: 1 },
];

const xlsx = mod.exports.matchTemplate('迪新货单', templates);
assert('Excel 模板去掉 .xlsx 后参与精确匹配', xlsx.name === '迪新货单.xlsx' && xlsx.kind === 'exact');

const unmatched = mod.exports.resolveAutoSelection?.('不存在的模板', templates);
assert('无匹配时明确返回空选中，不沿用旧模板', unmatched?.name === null && unmatched?.kind === 'none');

console.log(`\n结果：${2 - failed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
