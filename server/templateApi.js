// 模板文件与匹配配置的服务端 API。
// 由 webpack.config.js 的 devServer.setupMiddlewares 挂载到 express app。
// 模板按数据表隔离：templates/<tableId>/*.docx，每张表只看到自己目录下的模板。
// 匹配配置 templates/_config.json 全局，按 tableId 记录。全部纳入 git，本地部署直接调用。
const fs = require('fs');
const path = require('path');
const express = require('express');
const { stripWhiteBg } = require('./stampProcessor');

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');
const CONFIG_PATH = path.join(TEMPLATES_DIR, '_config.json');

function ensureStore() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ tables: {} }, null, 2), 'utf8');
  }
}

// 校验 tableId：飞书表 ID 形如 tbl8SmrWcQadcF9k，仅字母数字与短横线，
// 禁止路径成分与下划线开头（下划线前缀留给 _config.json / _legacy 等保留项）。
function safeTableId(raw) {
  if (typeof raw !== 'string' || !raw) throw httpError(400, '缺少数据表标识');
  const id = raw; // Express 已解码 query 参数，不可再次 decodeURIComponent。
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw httpError(400, '数据表标识非法');
  return id;
}

// 返回并按需创建某张表的模板目录
function tableDir(tableId) {
  const dir = path.join(TEMPLATES_DIR, tableId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 文件名清洗：所有涉及文件名的路由必经此关。
// 返回合法 basename，或抛出带 status 的错误。
function safeName(raw) {
  if (typeof raw !== 'string' || !raw) throw httpError(400, '缺少文件名');
  let name = raw; // Express 已解码 query/route 参数，二次解码会破坏含 % 的合法文件名。
  // 显式拒绝含路径成分的输入（不静默改名，避免 a/b.docx 悄悄变 b.docx 或路径穿越尝试）
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw httpError(400, '文件名不能含路径分隔符');
  }
  name = path.basename(name); // 双保险：去掉任何残留路径成分
  if (!/\.(docx|xlsx)$/i.test(name)) throw httpError(400, '仅支持 .docx / .xlsx 文件');
  if (name.startsWith('_')) throw httpError(400, '文件名不能以下划线开头');
  if (name.startsWith('~$')) throw httpError(400, '非法的临时文件名');
  // 拒绝控制字符与 Windows 保留字符（basename 后不应再有 / \，双保险）
  if (/[<>:"/\|?*]/.test(name)) throw httpError(400, '文件名含非法字符');
  if (/[\x00-\x1f]/.test(name)) throw httpError(400, '文件名含控制字符');
  if (name === '.docx' || name === '.xlsx') throw httpError(400, '文件名不能为空');
  const full = path.resolve(TEMPLATES_DIR, name);
  if (path.dirname(full) !== TEMPLATES_DIR) throw httpError(400, '路径越界');
  return name;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// SSRF 防护：判断主机名是否指向内网/回环（用于 /api/proxy-image）
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1') return true;
    if (/^f[cd]/.test(h)) return true; // fc00::/7（唯一本地地址）
    if (h.startsWith('fe80')) return true; // 链路本地
    return false;
  }
  return false;
}

// ============ 印章（stamp）支持 ============
// 印章图片按表隔离存储：templates/<tableId>/_stamps/<name>，仅 png/jpg/jpeg。
// 路径约定独立于模板 safeName（模板仅允许 docx/xlsx），下划线目录不会被模板列表读到。

const STAMP_EXT_RE = /\.(png|jpe?g)$/i;

function safeStampName(raw) {
  if (typeof raw !== 'string' || !raw) throw httpError(400, '缺少印章文件名');
  let name = raw; // Express 已解码 query/route 参数
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw httpError(400, '印章文件名不能含路径分隔符');
  }
  name = path.basename(name);
  if (!STAMP_EXT_RE.test(name)) throw httpError(400, '仅支持 .png / .jpg / .jpeg 图片');
  if (name.startsWith('~$')) throw httpError(400, '非法的临时文件名');
  if (/[<>:"/\|?*]/.test(name)) throw httpError(400, '文件名含非法字符');
  if (/[\x00-\x1f]/.test(name)) throw httpError(400, '文件名含控制字符');
  const full = path.resolve(TEMPLATES_DIR, name);
  if (path.dirname(full) !== TEMPLATES_DIR) throw httpError(400, '路径越界');
  return name;
}

function stampDir(tableId) {
  const dir = path.join(TEMPLATES_DIR, tableId, '_stamps');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stampContentType(name) {
  return /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
}

// 图片魔数校验：PNG=89 50 4E 47，JPEG=FF D8 FF
function isImageBuf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return false;
}

function send(res, status, body) {
  res.status(status).json(body);
}

// ============ 下载命名规则（downloadNames）落盘校验 ============
// 前端结构：{ [tableId]: { enabled, join, parts: [{kind:'field'|'text'|'sys', ...}] } }
// 这里做轻量清洗：过滤非法 tableId / 未知片段，避免脏数据让前端渲染异常。

const NAME_SYS_KEYS = ['date', 'time', 'datetime', 'tableName', 'templateName', 'recordId'];

function cleanNamePart(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'text') {
    return { kind: 'text', text: String(raw.text == null ? '' : raw.text).slice(0, 60) };
  }
  if (raw.kind === 'sys') {
    if (NAME_SYS_KEYS.indexOf(raw.sys) === -1) return null;
    return { kind: 'sys', sys: raw.sys };
  }
  if (raw.kind === 'field') {
    const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId.slice(0, 64) : '';
    const fieldName = typeof raw.fieldName === 'string' ? raw.fieldName.slice(0, 120) : '';
    if (!fieldId && !fieldName) return null;
    return { kind: 'field', fieldId, fieldName };
  }
  return null;
}

function cleanDownloadNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((tableId) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(tableId)) return;
    const cfg = raw[tableId];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
    const parts = (Array.isArray(cfg.parts) ? cfg.parts : [])
      .slice(0, 20)
      .map(cleanNamePart)
      .filter(Boolean);
    out[tableId] = {
      enabled: !!cfg.enabled,
      join: typeof cfg.join === 'string' ? cfg.join.slice(0, 4) : '-',
      parts,
    };
  });
  return out;
}

// ============ 合并字段规则（mergeFields）落盘校验 ============
// 新版结构：{ [tableId]: { [签名]: { branches: [{ join, conditions[], output{} }] } } }
// 旧版结构：{ join, conditions[], output{} }（单分支）——仍接受并原样保存，
// 前端读取时会自动迁移成 branches，存量配置不受影响。
// 签名形如 细菌数量|细菌乘方（占位符内字段名按顺序用 | 连接）。

const MERGE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notEmpty'];
const MERGE_MODES = ['concat', 'scientific', 'product', 'text'];
const MERGE_MAX_BRANCHES = 20;

function cleanMergeCondition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const field = typeof raw.field === 'string' ? raw.field.slice(0, 120).trim() : '';
  if (!field) return null;
  return {
    field,
    op: MERGE_OPS.indexOf(raw.op) !== -1 ? raw.op : 'eq',
    value: raw.value == null ? '' : String(raw.value).slice(0, 120),
  };
}

function cleanMergeOutput(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const precision = Number.isInteger(o.precision) && o.precision >= 0 && o.precision <= 6 ? o.precision : null;
  return {
    mode: MERGE_MODES.indexOf(o.mode) !== -1 ? o.mode : 'concat',
    separator: typeof o.separator === 'string' ? o.separator.slice(0, 8) : '',
    mantissaField: typeof o.mantissaField === 'string' ? o.mantissaField.slice(0, 120) : '',
    exponentField: typeof o.exponentField === 'string' ? o.exponentField.slice(0, 120) : '',
    superscript: o.superscript !== false,
    times: typeof o.times === 'string' && o.times ? o.times.slice(0, 8) : '×10',
    precision,
    text: typeof o.text === 'string' ? o.text.slice(0, 120) : '',
    fallback: typeof o.fallback === 'string' ? o.fallback.slice(0, 60) : '',
  };
}

function cleanMergeBranch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    join: raw.join === 'or' ? 'or' : 'and',
    conditions: (Array.isArray(raw.conditions) ? raw.conditions : [])
      .slice(0, 10)
      .map(cleanMergeCondition)
      .filter(Boolean),
    output: cleanMergeOutput(raw.output),
  };
}

function cleanMergeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  // 新版：多分支
  if (Array.isArray(raw.branches)) {
    const branches = raw.branches
      .slice(0, MERGE_MAX_BRANCHES)
      .map(cleanMergeBranch)
      .filter(Boolean);
    return branches.length ? { branches } : null;
  }

  // 旧版：单分支（保留原样结构，便于回滚到旧前端）
  if (!Array.isArray(raw.conditions) && !raw.output) return null;
  return {
    join: raw.join === 'or' ? 'or' : 'and',
    conditions: (Array.isArray(raw.conditions) ? raw.conditions : [])
      .slice(0, 10)
      .map(cleanMergeCondition)
      .filter(Boolean),
    output: cleanMergeOutput(raw.output),
  };
}

function cleanMergeFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((tableId) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(tableId)) return;
    const bySignature = raw[tableId];
    if (!bySignature || typeof bySignature !== 'object' || Array.isArray(bySignature)) return;
    const rules = {};
    Object.keys(bySignature).slice(0, 50).forEach((signature) => {
      if (!signature || signature.length > 200) return;
      const rule = cleanMergeRule(bySignature[signature]);
      if (rule) rules[signature] = rule;
    });
    if (Object.keys(rules).length > 0) out[tableId] = rules;
  });
  return out;
}

// ============ 附件图片尺寸（attachmentImages）落盘校验 ============
// 前端结构：{ [tableId]: { [字段名]: { widthCm } } }
// 只保留合法正数宽度并夹逼到 0.5~50cm，避免脏数据导致注入出超大图。

function cleanAttachmentImages(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((tableId) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(tableId)) return;
    const byField = raw[tableId];
    if (!byField || typeof byField !== 'object' || Array.isArray(byField)) return;
    const rules = {};
    Object.keys(byField).slice(0, 200).forEach((fieldName) => {
      if (!fieldName || fieldName.length > 120) return;
      const cfg = byField[fieldName];
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
      const w = Number(cfg.widthCm);
      if (!Number.isFinite(w) || w <= 0) return;
      rules[fieldName] = { widthCm: Math.min(50, Math.max(0.5, Math.round(w * 100) / 100)) };
    });
    if (Object.keys(rules).length > 0) out[tableId] = rules;
  });
  return out;
}

module.exports = function attach(app) {
  ensureStore();

  // 列表：某张表目录下的 .docx，中文排序。?tableId=xxx
  app.get('/api/templates', (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const dir = tableDir(tableId);
      const files = fs.readdirSync(dir)
        .filter((f) => /\.(docx|xlsx)$/i.test(f) && !f.startsWith('~$'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      send(res, 200, { templates: files });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : '读取模板列表失败：' + e.message });
    }
  });

  // 上传：raw body，校验 PK 魔数，重名需 overwrite=1。?tableId=xxx&name=yyy
  app.post('/api/templates', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const name = safeName(req.query.name);
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) throw httpError(400, '上传内容为空');
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw httpError(400, '不是有效的 Office 文件（docx/xlsx）');
      const full = path.join(tableDir(tableId), name);
      const overwrite = req.query.overwrite === '1';
      if (fs.existsSync(full) && !overwrite) {
        return send(res, 409, { error: '同名模板已存在', name });
      }
      fs.writeFileSync(full, buf);
      const st = fs.statSync(full);
      send(res, 200, { name, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // 删除：?tableId=xxx
  app.delete('/api/templates/:name', (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const name = safeName(req.params.name);
      const full = path.join(tableDir(tableId), name);
      if (!fs.existsSync(full)) return send(res, 404, { error: '模板不存在' });
      fs.unlinkSync(full);
      send(res, 200, { name });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // 复制（同表内）：{ tableId, source, target }
  app.post('/api/templates/copy', express.json(), (req, res) => {
    try {
      const tableId = safeTableId(req.body && req.body.tableId);
      const source = safeName(req.body && req.body.source);
      const target = safeName(req.body && req.body.target);
      const dir = tableDir(tableId);
      const src = path.join(dir, source);
      const dst = path.join(dir, target);
      if (!fs.existsSync(src)) return send(res, 404, { error: '源模板不存在' });
      if (fs.existsSync(dst)) return send(res, 409, { error: '目标模板已存在' });
      fs.copyFileSync(src, dst);
      const st = fs.statSync(dst);
      send(res, 200, { name: target, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // 匹配配置读写
  app.get('/api/config', (req, res) => {
    try {
      ensureStore();
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      send(res, 200, JSON.parse(raw));
    } catch (e) {
      send(res, 500, { error: '读取配置失败：' + e.message });
    }
  });

  app.put('/api/config', express.json(), (req, res) => {
    try {
     const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw httpError(400, '配置格式错误，需为 JSON 对象');
      }
      if (body.tables != null && (typeof body.tables !== 'object' || Array.isArray(body.tables))) {
        throw httpError(400, 'tables 需为对象');
      }
      // 只落盘已知字段（tables + downloadNames + mergeFields + attachmentImages），避免未知字段污染配置文件
      const next = {
        tables: body.tables && typeof body.tables === 'object' ? body.tables : {},
        downloadNames: cleanDownloadNames(body.downloadNames),
        mergeFields: cleanMergeFields(body.mergeFields),
        attachmentImages: cleanAttachmentImages(body.attachmentImages),
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
      send(res, 200, next);
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // ============ 附件图片代理 ============
  // 浏览器直连飞书附件域名会被 CORS 拦，这里由服务端代为拉取后回传（服务端无跨域限制）。
  // 防 SSRF：仅允许 https，并拒绝内网/回环主机。

  app.get('/api/proxy-image', async (req, res) => {
    try {
      const raw = req.query.url;
      if (typeof raw !== 'string' || !raw) throw httpError(400, '缺少 url 参数');
      let u;
      try {
        u = new URL(raw);
      } catch (e) {
        throw httpError(400, 'url 非法');
      }
      if (u.protocol !== 'https:') throw httpError(400, '仅允许 https 图片地址');
      if (isPrivateHost(u.hostname)) throw httpError(400, '不允许访问内网地址');
      if (typeof fetch !== 'function') throw httpError(500, '当前 Node 不支持 fetch，请升级到 Node 18+');

      const upstream = await fetch(u.toString(), {
        redirect: 'follow',
        headers: {
          // 部分 CDN 对缺少 UA/Accept 的请求直接返回 404/403，这里模拟浏览器
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      if (!upstream.ok) {
        // 关键诊断：把源站域名与 URL 打到 dev server 日志（pm2 logs 可看），
        // 用于区分「内网/需鉴权的地址」与「签名地址过期」。
        console.warn(
          `[proxy-image] 上游返回 ${upstream.status} | host=${u.hostname} | url=${u.toString().slice(0, 200)}`
        );
        const err = httpError(502, `图片下载失败（HTTP ${upstream.status}）`);
        err.host = u.hostname; // 回传给前端，便于判断是「代理没生效」还是「源站拒绝」
        err.upstreamStatus = upstream.status;
        throw err;
      }
      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      if (!/^image\//i.test(ct)) {
        console.warn(`[proxy-image] 返回非图片 host=${u.hostname} content-type=${ct}`);
        const err = httpError(502, `返回内容不是图片（${ct}）`);
        err.host = u.hostname;
        throw err;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0) throw httpError(502, '图片内容为空');
      if (buf.length > 15 * 1024 * 1024) throw httpError(413, '图片过大（超过 15MB）');
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      if (!res.headersSent) {
        send(res, e.status || 500, {
          error: e.message || '图片代理失败',
          host: e.host,
          upstreamStatus: e.upstreamStatus,
        });
      }
    }
  });

  // ============ 印章 API ============

  // 列表：某张表的印章图片。?tableId=xxx
  app.get('/api/stamps', (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const dir = stampDir(tableId);
      const files = fs.readdirSync(dir)
        .filter((f) => STAMP_EXT_RE.test(f) && !f.startsWith('~$') && !f.includes('.bak'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      send(res, 200, { stamps: files });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : '读取印章列表失败：' + e.message });
    }
  });

  // 上传：raw body，校验图片魔数。?tableId=xxx&name=yyy（同名覆盖，简化管理）
  // PNG 自动去白底（纯 JS 实现，零外部依赖）。
  app.post('/api/stamps', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const name = safeStampName(req.query.name);
      const kind = isImageBuf(req.body);
      if (!kind) throw httpError(400, '不是有效的 PNG / JPEG 图片');
      const extOk = kind === 'png' ? /\.png$/i.test(name) : /\.jpe?g$/i.test(name);
      if (!extOk) throw httpError(400, '图片格式与文件扩展名不符');
      const full = path.join(stampDir(tableId), name);

      // 先保存原始文件（兜底）
      fs.writeFileSync(full, req.body);

      // PNG 自动去白底：白底 → 透明背景
      let stripped = false;
      if (kind === 'png') {
        try {
          const processed = stripWhiteBg(req.body);
          if (processed) {
            fs.writeFileSync(full, processed);
            stripped = true;
            console.log(`[stamp] 去白底成功: ${name} (${req.body.length} → ${processed.length} bytes)`);
          } else {
            console.log(`[stamp] 去白底跳过(不支持的PNG子格式): ${name}`);
          }
        } catch (e) {
          console.warn(`[stamp] 去白底失败，保留原图: ${name} - ${e.message}`);
        }
      }

      const st = fs.statSync(full);
      send(res, 200, { name, size: st.size, mtime: st.mtimeMs, stripped });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // 读取：返回图片二进制，前端 <img> 直接引用。?tableId=xxx
  app.get('/api/stamps/:name', (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const name = safeStampName(req.params.name);
      const full = path.join(stampDir(tableId), name);
      if (!fs.existsSync(full)) return send(res, 404, { error: '印章不存在' });
      res.setHeader('Content-Type', stampContentType(name));
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(full);
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // 删除：?tableId=xxx
  app.delete('/api/stamps/:name', (req, res) => {
    try {
      const tableId = safeTableId(req.query.tableId);
      const name = safeStampName(req.params.name);
      const full = path.join(stampDir(tableId), name);
      if (!fs.existsSync(full)) return send(res, 404, { error: '印章不存在' });
      fs.unlinkSync(full);
      send(res, 200, { name });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });
};
