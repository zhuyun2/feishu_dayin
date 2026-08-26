const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const TABLE_ID = `tblCodex${RUN_ID}`;
const NAME = `100%测试-${RUN_ID}.docx`;
const COPY = `100%测试-副本-${RUN_ID}.docx`;
const SOURCE = path.join(ROOT, 'public', 'templates', 'tbldeXFrTixlf6sB', 'Antimicro 苯氧乙.docx');
const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:5199';
const target = new URL(BASE);
if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
  throw new Error('模板 API 写入测试只允许连接本机地址');
}

let failed = 0;
function assert(name, condition) {
  if (condition) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name); }
}

function templateUrl(name) {
  return `${BASE}/api/templates/${encodeURIComponent(name)}?tableId=${TABLE_ID}`;
}

async function cleanup() {
  await fetch(templateUrl(COPY), { method: 'DELETE' }).catch(() => {});
  await fetch(templateUrl(NAME), { method: 'DELETE' }).catch(() => {});
  const dir = path.join(ROOT, 'templates', TABLE_ID);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

(async () => {
  await cleanup();
  try {
    const body = fs.readFileSync(SOURCE);
    const upload = await fetch(
      `${BASE}/api/templates?tableId=${TABLE_ID}&name=${encodeURIComponent(NAME)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }
    );
    if (upload.status !== 200) console.log('    upload:', upload.status, await upload.clone().text());
    assert('含 % 的合法文件名可上传', upload.status === 200);

    const list = await fetch(`${BASE}/api/templates?tableId=${TABLE_ID}`).then((res) => res.json());
    assert('列表返回上传的模板', list.templates?.some((item) => item.name === NAME));

    const copy = await fetch(`${BASE}/api/templates/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId: TABLE_ID, source: NAME, target: COPY }),
    });
    assert('含 % 的模板可复制', copy.status === 200);

    const download = await fetch(`${BASE}/templates/${TABLE_ID}/${encodeURIComponent(COPY)}`);
    assert('复制后的模板可下载', download.status === 200 && (await download.arrayBuffer()).byteLength > 0);

    const removeCopy = await fetch(templateUrl(COPY), { method: 'DELETE' });
    const removeOriginal = await fetch(templateUrl(NAME), { method: 'DELETE' });
    assert('含 % 的模板可删除', removeCopy.status === 200 && removeOriginal.status === 200);
  } finally {
    await cleanup();
  }

  console.log(`\n结果：${5 - failed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
