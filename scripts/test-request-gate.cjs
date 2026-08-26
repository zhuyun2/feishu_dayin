const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const file = path.resolve(__dirname, '..', 'src/services/requestGate.ts');
let api = {};
if (fs.existsSync(file)) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  api = mod.exports;
}

let failed = 0;
function assert(name, condition) {
  if (condition) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name); }
}

const gate = api.createRequestGate?.();
const first = gate?.start();
const second = gate?.start();
assert('新请求启动后旧请求失效', first?.isCurrent() === false);
assert('最新请求可以提交结果', second?.isCurrent() === true);
gate?.invalidate();
assert('输入切换后在途请求失效', second?.isCurrent() === false);

console.log(`\n结果：${3 - failed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
