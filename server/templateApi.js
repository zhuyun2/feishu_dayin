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
      if (!body || typeof body !== 'object' || typeof body.tables !== 'object' || body.tables === null) {
        throw httpError(400, '配置格式错误，需为 { tables: {...} }');
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2), 'utf8');
      send(res, 200, body);
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
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
