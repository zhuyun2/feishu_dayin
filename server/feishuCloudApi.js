'use strict';
// 飞书云文档传输：把打印产物（docx/xlsx）以「用户身份」推送到云盘指定文件夹。
//
// 为什么在服务端做：
//   1) app_secret 绝不能进前端；
//   2) 浏览器直连 open.feishu.cn 会撞 CORS；
//   3) user_access_token 的换取/持久化/刷新需要落盘，只能在服务端。
// 由 webpack.config.js 的 devServer.setupMiddlewares 挂载（与 templateApi / pdfApi 同模式）。
//
// 鉴权：OAuth v2 授权码流程
//   授权页 https://accounts.feishu.cn/open-apis/authen/v1/authorize
//   换/刷令牌 https://open.feishu.cn/open-apis/authen/v2/oauth/token
//   scope 必须含 offline_access，否则不返回 refresh_token（长期使用会频繁重新授权）。
//
// 落盘：
//   server/feishuConfig.json      —— 应用凭证（appId/appSecret），**不入库**（见 .gitignore）
//   server/.feishu-user-token.json —— 用户令牌，运行时产物，**不入库**
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const CONFIG_PATH = path.join(__dirname, 'feishuConfig.json');
const TOKEN_PATH = path.join(__dirname, '.feishu-user-token.json');

const OPEN_API = 'https://open.feishu.cn/open-apis';
const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
// drive:drive = 查看/评论/编辑和管理云空间中所有文件（上传 + 列目录两件事都由它覆盖）
// offline_access = 允许换取 refresh_token（不加则 2 小时后必须重新授权）
const DEFAULT_SCOPES = ['drive:drive', 'offline_access'];

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 官方 upload_all 单文件上限
const REFRESH_MARGIN_MS = 60 * 1000;       // 提前 60s 视为过期，避免边界失败
const STATE_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 200;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ============ 配置与令牌 ============

function loadConfig() {
  const cfg = readJson(CONFIG_PATH);
  if (!cfg || !cfg.appId || !cfg.appSecret) return null;
  return {
    appId: String(cfg.appId).trim(),
    appSecret: String(cfg.appSecret).trim(),
    // 可选：显式指定回调地址，留空则按请求 Host 推导
    redirectUri: cfg.redirectUri ? String(cfg.redirectUri).trim() : '',
    scopes: Array.isArray(cfg.scopes) && cfg.scopes.length ? cfg.scopes.map(String) : DEFAULT_SCOPES,
  };
}

function loadToken() {
  const t = readJson(TOKEN_PATH);
  if (!t || !t.accessToken) return null;
  return t;
}

function saveToken(t) {
  writeJson(TOKEN_PATH, t);
}

function clearToken() {
  try { fs.rmSync(TOKEN_PATH, { force: true }); } catch (e) { /* 忽略 */ }
}

// 判断当前授权是否**真的可用**。
// 只看「有没有 accessToken」是不够的：accessToken 只有 2 小时有效期，
// 只要 refresh_token 还在有效期内就能自动续上；两者都失效才需要用户重新授权。
// 之前这里只判 token 存在，导致 refresh 过期后界面仍显示「已授权」、且不出现重新授权按钮。
function authState() {
  const t = loadToken();
  if (!t || !t.accessToken) return { authorized: false, expired: false, token: null };
  const now = Date.now();
  const accessUsable = !t.expiresAt || now < t.expiresAt - REFRESH_MARGIN_MS;
  const canRefresh = !!t.refreshToken && (!t.refreshExpiresAt || now < t.refreshExpiresAt);
  if (accessUsable || canRefresh) return { authorized: true, expired: false, token: t };
  return { authorized: false, expired: true, token: t };
}

// 隧道(cloudflare)后 req.protocol 常为 http，必须优先读 X-Forwarded-*，
// 否则推导出的 redirectUri 与飞书后台登记的不一致 → 授权直接失败。
function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol;
  const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() || req.get('host');
  return `${proto}://${host}`;
}

function redirectUriFor(req) {
  const cfg = loadConfig();
  if (cfg && cfg.redirectUri) return cfg.redirectUri;
  return `${publicOrigin(req)}/api/cloud/oauth/callback`;
}

// ============ 飞书 OpenAPI 调用 ============

async function callOpenApi(method, pathname, { token, body, query } = {}) {
  const url = new URL(OPEN_API + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw httpError(502, `无法连接飞书开放平台：${e.message || e}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    throw httpError(502, `飞书返回了非 JSON 响应（HTTP ${res.status}）`);
  }
  // 飞书业务失败：HTTP 200 + code!=0，或 HTTP 4xx/5xx + code
  const code = json && json.code;
  if (code !== 0 && code !== undefined) {
    throw httpError(res.ok ? 400 : res.status, feishuErrorText(code, json.msg));
  }
  if (!res.ok) {
    throw httpError(res.status, `飞书接口调用失败（HTTP ${res.status}）`);
  }
  return json;
}

// 把飞书错误码翻译成用户能看懂的中文指引（尤其 1061004，最容易踩）
function feishuErrorText(code, msg) {
  const table = {
    1061004: '当前账号对该文件夹没有编辑权限。请确认文件夹是你本人可写的（用本人身份上传，无需共享给应用；若文件夹属于他人，请先让对方给你「可编辑」权限）',
    1061044: '目标文件夹不存在或已被删除，请重新选择',
    1061043: '文件超过云盘上传大小限制',
    1061101: '租户云盘容量已满',
    1061061: '个人云盘容量已满',
    1061073: '应用未开通所需权限，请在开放平台为应用添加「查看、评论、编辑和管理云空间中所有文件」并发布版本',
    99991679: '授权范围不足，请重新点击「去飞书授权」并在授权页同意全部权限',
  };
  if (table[code]) return `${table[code]}（飞书错误码 ${code}）`;
  return `飞书接口报错：${msg || '未知错误'}（错误码 ${code}）`;
}

// 换取 / 刷新 user_access_token（v2 接口，不需要 app_access_token）
async function requestToken(grantBody) {
  const cfg = loadConfig();
  if (!cfg) throw httpError(400, '尚未配置飞书应用凭证：请在 server/feishuConfig.json 填入 appId / appSecret');

  let res;
  try {
    res = await fetch(`${OPEN_API}/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(grantBody),
    });
  } catch (e) {
    throw httpError(502, `无法连接飞书开放平台：${e.message || e}`);
  }
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0 || !json.access_token) {
    const detail = json?.error_description || json?.msg || json?.error || `HTTP ${res.status}`;
    throw httpError(400, `获取飞书授权令牌失败：${detail}`);
  }
  return json;
}

async function fetchUserInfo(accessToken) {
  try {
    const json = await callOpenApi('GET', '/authen/v1/user_info', { token: accessToken });
    const d = json.data || {};
    return { name: d.name || '', avatarUrl: d.avatar_url || '', openId: d.open_id || '' };
  } catch (e) {
    return { name: '', avatarUrl: '', openId: '' };
  }
}

// 取一个可用的 user_access_token：未过期直接用，过期用 refresh_token 续期。
// 续期也失败则抛 401，由前端引导用户重新授权。
let refreshInFlight = null;
async function getValidToken() {
  const cfg = loadConfig();
  if (!cfg) throw httpError(400, '尚未配置飞书应用凭证');

  const t = loadToken();
  if (!t) throw httpError(401, '尚未授权飞书账号，请先点击「去飞书授权」');
  if (t.expiresAt && Date.now() < t.expiresAt - REFRESH_MARGIN_MS) return t.accessToken;

  if (!t.refreshToken) throw httpError(401, '飞书授权已过期，请重新授权');
  if (t.refreshExpiresAt && Date.now() >= t.refreshExpiresAt) {
    throw httpError(401, '飞书授权已超过 30 天未使用，请重新授权');
  }

  // 并发去重：多个请求同时过期只刷一次
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const json = await requestToken({
        grant_type: 'refresh_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        refresh_token: t.refreshToken,
      });
      const next = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || t.refreshToken,
        expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000,
        refreshExpiresAt: Date.now() + (Number(json.refresh_token_expires_in) || 30 * 24 * 3600) * 1000,
        user: t.user || null,
        scope: json.scope || t.scope || '',
      };
      saveToken(next);
      return next;
    })().finally(() => { refreshInFlight = null; });
  }
  const next = await refreshInFlight;
  return next.accessToken;
}

// ============ 上传（multipart 手工拼装，不依赖 Node 版本 / 第三方库） ============

function buildMultipart(fields, file) {
  const boundary = '----feishuprint' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'
    ));
  }
  // 文件名按飞书要求做转义，避免引号/中文导致解析失败
  const safeName = file.name.replace(/["\r\n]/g, '_');
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`, 'utf8'
  ));
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function guessMime(name) {
  if (/\.xlsx$/i.test(name)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.docx$/i.test(name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

async function uploadFile({ token, folderToken, fileName, buffer }) {
  const { boundary, body } = buildMultipart(
    {
      file_name: fileName,
      parent_type: 'explorer',
      parent_node: folderToken,
      size: String(buffer.length),
    },
    { name: fileName, type: guessMime(fileName), buffer }
  );

  let res;
  try {
    res = await fetch(`${OPEN_API}/drive/v1/files/upload_all`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  } catch (e) {
    throw httpError(502, `上传失败，无法连接飞书：${e.message || e}`);
  }
  const json = await res.json().catch(() => null);
  if (!json) throw httpError(502, `上传失败，飞书返回了非 JSON 响应（HTTP ${res.status}）`);
  if (json.code !== 0) throw httpError(res.ok ? 400 : res.status, feishuErrorText(json.code, json.msg));
  const data = json.data || {};
  return {
    fileToken: data.file_token || '',
    name: data.name || fileName,
    url: data.url || '',
  };
}

// ============ 多维表格自动化 Webhook ============
// 推送成功后 POST 一条 JSON 到「多维表格自动化 → 接收到 webhook 时」的地址。
// 配置按「多维表格文档(baseId)」独立保存，落在 templates/_config.json 的 cloudPush 段：
//   cloudPush[baseId] = { webhookUrl, bodyTemplate }
// 某个多维表格没单独配置时，回退到 server/feishuConfig.json 的 webhookUrl（兼容早期全局配置）。
//
// 官方约束：请求体必须是合法 JSON；若自动化里把请求体设为「发送示例请求」，
// 字段结构要与示例一致（否则报 800006003）。通知失败**不影响**已上传的文件。

const APP_CONFIG_PATH = path.join(__dirname, '..', 'templates', '_config.json');

const WEBHOOK_TIMEOUT_MS = 10000;
const WEBHOOK_ERRORS = {
  800004509: '该自动化的 webhook 触发已被停用，请在多维表格里启用',
  800005647: '通知请求体过大（上限 4MB）',
  800005649: 'Bearer token 校验失败：自动化开启了凭证校验',
  800005650: '来源 IP 不在自动化的 IP 白名单内',
  800005652: '触发过于频繁被限流，请稍后重试',
  800006003: '请求体结构与自动化里的「示例请求」不一致，请按文档给的 JSON 结构重设示例',
};

// 默认请求体模板：变量会在发送前替换，所以必须写在 JSON 字符串里
const DEFAULT_BODY_TEMPLATE = [
  '{',
  '  "fileName": "{{fileName}}",',
  '  "pusher": "{{pusher}}",',
  '  "text": "{{pusher}} 推送了「{{fileName}}」到飞书云盘",',
  '  "pushedAt": "{{pushedAt}}",',
  '  "fileUrl": "{{fileUrl}}",',
  '  "folderName": "{{folderName}}"',
  '}',
].join('\n');

// 可引用的变量（供前端设置面板展示）
const TEMPLATE_VARS = ['fileName', 'pusher', 'text', 'pushedAt', 'fileUrl', 'folderName'];

function formatLocalTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 只认「当前多维表格」自己的配置；默认不启用。
// active（真正会发通知）= 启用 && 地址非空 —— 两者缺一都不发。
function resolveWebhookConfig(baseId) {
  const appCfg = readJson(APP_CONFIG_PATH) || {};
  const push = appCfg.cloudPush && typeof appCfg.cloudPush === 'object' ? appCfg.cloudPush : {};
  const per = baseId ? push[baseId] : null;
  const enabled = !!(per && per.enabled === true);
  const url = (per && String(per.webhookUrl || '').trim()) || '';
  return {
    enabled,
    webhookUrl: url,
    bodyTemplate: (per && String(per.bodyTemplate || '').trim()) || DEFAULT_BODY_TEMPLATE,
    active: enabled && !!url,
  };
}

// 把 {{变量}} 替换成真实值；值按 JSON 字符串转义（去掉首尾引号），
// 因此模板里的占位符必须写在 JSON 字符串中，如 "fileName": "{{fileName}}"。
// 未知变量原样保留 —— 让用户一眼看出写错了，而不是被静默清空。
function renderBodyTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return m;
    return JSON.stringify(String(vars[name] == null ? '' : vars[name])).slice(1, -1);
  });
}

// override：设置面板「测试发送」时可直接传未保存的 webhookUrl / bodyTemplate
async function sendAutomationWebhook({ baseId, fileName, pusher, fileUrl, folderName, override }) {
  const resolved = resolveWebhookConfig(baseId);
  // override（设置面板的「测试发送」）绕过启用开关，但地址仍必须有效
  const hasOverride = !!(override && (override.webhookUrl !== undefined || override.bodyTemplate !== undefined));
  const webhookUrl = override && override.webhookUrl !== undefined
    ? String(override.webhookUrl).trim()
    : resolved.webhookUrl;
  const bodyTemplate = override && override.bodyTemplate !== undefined && String(override.bodyTemplate).trim()
    ? String(override.bodyTemplate)
    : resolved.bodyTemplate;

  // 未启用 → 一律不发；已启用但地址为空 → 也不发
  if (!hasOverride) {
    if (!resolved.enabled) return { skipped: true, reason: 'disabled' };
    if (!resolved.webhookUrl) return { skipped: true, reason: 'no-url' };
  }
  if (!webhookUrl) return { skipped: true, reason: 'no-url' };

  const vars = {
    fileName: fileName || '',
    pusher: pusher || '',
    text: `${pusher || '有人'} 推送了「${fileName || ''}」到飞书云盘`,
    pushedAt: formatLocalTime(new Date()),
    fileUrl: fileUrl || '',
    folderName: folderName || '',
  };

  let payload;
  try {
    payload = JSON.parse(renderBodyTemplate(bodyTemplate, vars));
  } catch (e) {
    return { ok: false, error: `通知请求体模板替换后不是合法 JSON：${e.message}` };
  }

  let res;
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `通知失败，无法连接自动化 Webhook：${e.message || e}` };
  }

  const json = await res.json().catch(() => null);
  if (!json) return { ok: false, error: `通知失败，Webhook 返回非 JSON（HTTP ${res.status}）` };
  if (json.code !== 0) {
    const hint = WEBHOOK_ERRORS[json.code];
    return {
      ok: false,
      code: json.code,
      error: hint ? `通知失败：${hint}（code ${json.code}）` : `通知失败（code ${json.code}）：${json.msg || '未知错误'}`,
    };
  }
  return { ok: true };
}


// ============ OAuth state（防 CSRF，内存即可，重启即失效） ============
const pendingStates = new Map();

function issueState() {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (now - v > STATE_TTL_MS) pendingStates.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, now);
  return state;
}

function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const at = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}

// ============ 路由 ============

// 从「文件夹链接」或纯 token 里解析出 folder_token。
// 飞书的文件夹地址形如：
//   https://xxx.feishu.cn/drive/folder/<token>
//   https://xxx.feishu.cn/drive/shared/folder/<token>
//   https://xxx.feishu.cn/folder/<token>
// 共享文件夹（别人共享给你 / 共享空间）不在「我的空间」清单里，
// 目前没有公开接口可以枚举，只能靠粘贴链接拿到 token 后直接访问。
function parseFolderRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[A-Za-z0-9_-]{10,80}$/.test(s)) return s; // 直接粘的 token
  const m = s.match(/\/folder\/([A-Za-z0-9_-]{10,80})/);
  if (m) return m[1];
  try {
    const seg = new URL(s).pathname.split('/').filter(Boolean).pop() || '';
    if (/^[A-Za-z0-9_-]{10,80}$/.test(seg)) return seg;
  } catch (e) { /* 不是 URL，忽略 */ }
  return '';
}

module.exports = function attach(app) {
  const jsonBody = express.json({ limit: '1mb' });

  // 授权状态：前端据此决定显示「去授权」还是文件夹选择器
  app.get('/api/cloud/status', (req, res) => {
    const cfg = loadConfig();
    if (!cfg) {
      return res.json({
        configured: false,
        authorized: false,
        redirectUri: '',
        scopes: DEFAULT_SCOPES,
        hint: `未配置飞书应用凭证：请在 ${path.relative(path.join(__dirname, '..'), CONFIG_PATH)} 填入 appId / appSecret（可复制 feishuConfig.example.json）`,
      });
    }
    const st = authState();
    // base_id 可选：带上时按该多维表格的独立配置判断「通知是否已配置」
    const webhook = resolveWebhookConfig(String(req.query.base_id || ''));
    res.json({
      configured: true,
      authorized: st.authorized,
      // 有令牌但 access + refresh 都已过期 → 必须重新授权
      authExpired: st.expired,
      user: st.token?.user || null,
      expiresAt: st.token?.expiresAt || 0,
      refreshExpiresAt: st.token?.refreshExpiresAt || 0,
      // webhookConfigured = 真正会发通知（启用 + 地址非空），前端据此显示提示
      webhookConfigured: webhook.active,
      webhookEnabled: webhook.enabled,
      defaultBodyTemplate: DEFAULT_BODY_TEMPLATE,
      templateVars: TEMPLATE_VARS,
      redirectUri: redirectUriFor(req),
      scopes: cfg.scopes,
    });
  });

  // 生成授权链接（前端 window.open 打开，避免在飞书侧边栏 iframe 里跳转）
  app.post('/api/cloud/oauth/start', (req, res) => {
    const cfg = loadConfig();
    if (!cfg) return res.status(400).json({ error: '尚未配置飞书应用凭证（server/feishuConfig.json）' });

    const redirectUri = redirectUriFor(req);
    const state = issueState();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    res.json({ authorizeUrl: url.toString(), redirectUri });
  });

  // 飞书授权回跳：换令牌 → 落盘 → 返回一个可关闭的提示页
  app.get('/api/cloud/oauth/callback', async (req, res) => {
    const { code, state, error: cbError, error_description: cbDesc } = req.query;
    const fail = (title, detail) => res.status(200).type('html').send(callbackPage(false, title, detail));

    try {
      if (cbError) return fail('授权未完成', String(cbDesc || cbError));
      if (!consumeState(String(state || ''))) {
        return fail('授权校验失败', 'state 无效或已过期（超过 10 分钟），请回到插件重新点击「去飞书授权」');
      }
      if (!code) return fail('授权失败', '飞书未返回授权码 code');

      const cfg = loadConfig();
      if (!cfg) return fail('授权失败', '未配置飞书应用凭证');

      const json = await requestToken({
        grant_type: 'authorization_code',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        code: String(code),
        redirect_uri: redirectUriFor(req),
      });

      const user = await fetchUserInfo(json.access_token);
      saveToken({
        accessToken: json.access_token,
        refreshToken: json.refresh_token || '',
        expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000,
        refreshExpiresAt: Date.now() + (Number(json.refresh_token_expires_in) || 30 * 24 * 3600) * 1000,
        user,
        scope: json.scope || '',
      });

      if (!json.refresh_token) {
        return res.status(200).type('html').send(callbackPage(
          true, '授权成功',
          '注意：本次未获取到 refresh_token，2 小时后需要重新授权。请在授权页勾选/放开离线访问权限（scope 需含 offline_access）。'
        ));
      }
      return res.status(200).type('html').send(callbackPage(true, '授权成功', `已绑定飞书账号${user.name ? '：' + user.name : ''}，现在可以关闭本页回到插件推送文档了。`));
    } catch (e) {
      return fail('授权失败', e?.message || String(e));
    }
  });

  // 退出授权（清本地令牌）
  app.post('/api/cloud/oauth/logout', (req, res) => {
    clearToken();
    res.json({ ok: true });
  });

  // 列出某文件夹下的子文件夹（默认只返回文件夹，用于选择器）
  app.get('/api/cloud/folders', async (req, res) => {
    try {
      const token = await getValidToken();
      const folderToken = String(req.query.folder_token || '');

      // 根目录不支持分页，逐页拉取直到没有 page_token
      const folders = [];
      let pageToken = '';
      for (let i = 0; i < 20; i++) {
        const json = await callOpenApi('GET', '/drive/v1/files', {
          token,
          query: { folder_token: folderToken, page_size: LIST_PAGE_SIZE, page_token: pageToken },
        });
        const data = json.data || {};
        for (const f of data.files || []) {
          if (f.type === 'folder') {
            folders.push({ token: f.token, name: f.name || '未命名文件夹' });
          } else if (
            f.type === 'shortcut' &&
            f.shortcut_info &&
            f.shortcut_info.target_type === 'folder' &&
            f.shortcut_info.target_token
          ) {
            // 指向文件夹的快捷方式：常见做法是把别人共享给你的文件夹「添加到我的空间」，
            // 展开成目标文件夹，这样共享文件夹也能在列表里直接选到。
            folders.push({ token: f.shortcut_info.target_token, name: f.name || '未命名文件夹', viaShortcut: true });
          }
        }
        pageToken = data.next_page_token || '';
        if (!data.has_more || !pageToken) break;
      }
      folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      res.json({ folderToken, folders });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || '读取文件夹失败' });
    }
  });

  // 解析「共享文件夹链接 / token」→ 返回 folderToken + 文件夹名。
  // 用于把浏览起点切换到一个不在「我的空间」下的文件夹（共享给本人的、共享空间的等）。
  app.get('/api/cloud/folder-meta', async (req, res) => {
    try {
      const token = await getValidToken();
      const folderToken = parseFolderRef(req.query.ref);
      if (!folderToken) {
        return res.status(400).json({
          error: '无法识别文件夹：请粘贴形如 https://xxx.feishu.cn/drive/folder/<token> 的链接，或直接粘贴文件夹 token',
        });
      }
      const json = await callOpenApi(
        'GET',
        `/drive/explorer/v2/folder/${encodeURIComponent(folderToken)}/meta`,
        { token }
      );
      const d = json.data || {};
      res.json({ folderToken, name: d.name || '未命名文件夹' });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || '解析文件夹失败' });
    }
  });

  // 校验某个文件夹是否可写（提前把 1061004 暴露出来，而不是等推送时才报错）
  app.post('/api/cloud/verify', jsonBody, async (req, res) => {
    try {
      const token = await getValidToken();
      const folderToken = String(req.body?.folderToken || '');
      const json = await callOpenApi('GET', '/drive/v1/files', {
        token,
        query: { folder_token: folderToken, page_size: 1 },
      });
      res.json({ ok: true, folderToken, sample: (json.data?.files || []).length });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || '校验失败' });
    }
  });

  // 推送文档：body 为文件二进制，folder_token / file_name 走 query
  app.post(
    '/api/cloud/upload',
    express.raw({ type: () => true, limit: '30mb' }),
    async (req, res) => {
      try {
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          return res.status(400).json({ error: '上传内容为空' });
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
          return res.status(400).json({ error: `文件超过云盘单文件上限（20MB），当前 ${(buf.length / 1048576).toFixed(1)}MB` });
        }
        const fileName = String(req.query.file_name || '').trim();
        if (!fileName) return res.status(400).json({ error: '缺少文件名' });
        if (!/\.(docx|xlsx)$/i.test(fileName)) return res.status(400).json({ error: '仅支持 .docx / .xlsx' });

        const token = await getValidToken();
        const folderToken = String(req.query.folder_token || '');
        const folderName = String(req.query.folder_name || '');
        const baseId = String(req.query.cfg_key || '');
        const result = await uploadFile({ token, folderToken, fileName, buffer: buf });

        // 推送成功后再通知自动化；通知失败不回滚已上传的文件，只把原因回报给前端
        const pusher = loadToken()?.user?.name || '';
        const webhook = await sendAutomationWebhook({
          baseId,
          fileName: result.name || fileName,
          pusher,
          fileUrl: result.url || '',
          folderName,
        });

        res.json({ ok: true, ...result, pusher, webhook });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || '推送失败' });
      }
    }
  );

  // 试发一次自动化通知（设置面板「测试发送」用；可传尚未保存的地址与模板）
  app.post('/api/cloud/webhook/test', jsonBody, async (req, res) => {
    try {
      const body = req.body || {};
      const out = await sendAutomationWebhook({
        baseId: String(body.baseId || ''),
        fileName: '测试文件.docx',
        pusher: loadToken()?.user?.name || '测试用户',
        fileUrl: '',
        folderName: '测试文件夹',
        override: {
          webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
          bodyTemplate: typeof body.bodyTemplate === 'string' ? body.bodyTemplate : undefined,
        },
      });
      if (out.skipped) return res.status(400).json({ error: '尚未配置 Webhook 地址' });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message || '试发失败' });
    }
  });
};

// 供单元测试直接引用（不影响正常挂载使用）
module.exports.renderBodyTemplate = renderBodyTemplate;
module.exports.resolveWebhookConfig = resolveWebhookConfig;
module.exports.sendAutomationWebhook = sendAutomationWebhook;
module.exports.parseFolderRef = parseFolderRef;
module.exports.DEFAULT_BODY_TEMPLATE = DEFAULT_BODY_TEMPLATE;

// 授权回跳结果页（纯静态 HTML，无外部资源）
function callbackPage(ok, title, detail) {
  const color = ok ? '#34c724' : '#f5222d';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f7;color:#1f2329}
  .box{background:#fff;border:1px solid #e5e6eb;border-radius:12px;padding:32px 36px;max-width:520px;
       box-shadow:0 4px 16px rgba(0,0,0,.06);text-align:center}
  .dot{width:44px;height:44px;border-radius:50%;background:${color};color:#fff;font-size:24px;
       line-height:44px;margin:0 auto 16px}
  h1{font-size:17px;margin:0 0 10px}
  p{font-size:13px;line-height:1.7;color:#646a73;margin:0}
</style></head><body>
<div class="box">
  <div class="dot">${ok ? '✓' : '!'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
