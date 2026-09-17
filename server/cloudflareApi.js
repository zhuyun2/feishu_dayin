'use strict';
/**
 * ============================================================
 * Cloudflare API 小客户端 —— 只服务于「自动创建固定域名」这一件事
 * ============================================================
 * 为什么需要它：项目里的 deploy/cloudflared/cert.pem 其实不是证书，
 * 而是一段 **ARGO TUNNEL TOKEN**，base64 里包着 { zoneID, accountID, apiToken }。
 * 有了它就能直接调 Cloudflare API 建隧道、配 DNS，用户不必去后台点。
 *
 * 设计约束：
 *   - 只被 `setupCore.js add-domain` 使用；**日常部署完全不依赖网络 API**，
 *     所以令牌失效也不会影响已配好的域名（这点很重要，别把两者耦合起来）。
 *   - 任何失败都抛出带可读信息的 Error，让上层能优雅退回「手动创建」指引。
 *   - 不做重试：这是写操作，重试可能建出重复隧道。
 * ============================================================
 */

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const API_HOST = 'api.cloudflare.com';

/* ------------------------------------------------------------ 令牌解析 */

/**
 * cert.pem（ARGO TUNNEL TOKEN）→ { apiToken, accountID, zoneID }
 * 逐层校验并抛清晰错误：这一步失败通常意味着 cert.pem 被换掉或来源不对。
 */
function parseCertToken(certFile) {
  let text;
  try {
    text = fs.readFileSync(certFile, 'utf8');
  } catch (e) {
    const err = new Error('读不到令牌文件：' + certFile);
    err.code = 'NO_CERT';
    throw err;
  }
  const m = text.match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/);
  if (!m) {
    const err = new Error('该文件不是 ARGO TUNNEL TOKEN 格式，无法自动建隧道：' + certFile);
    err.code = 'BAD_CERT';
    throw err;
  }
  let info;
  try {
    info = JSON.parse(Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch (e) {
    const err = new Error('令牌内容无法解析：' + e.message);
    err.code = 'BAD_CERT';
    throw err;
  }
  if (!info.apiToken || !info.accountID || !info.zoneID) {
    const err = new Error('令牌里缺少 apiToken / accountID / zoneID，无法自动建隧道');
    err.code = 'BAD_CERT';
    throw err;
  }
  return { apiToken: info.apiToken, accountID: info.accountID, zoneID: info.zoneID };
}

/* ------------------------------------------------------------ HTTP 底座 */

function request(method, apiPath, opts) {
  const options = opts || {};
  const body = options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: '/client/v4' + apiPath,
        method,
        timeout: 30000,
        headers: Object.assign(
          {
            Authorization: 'Bearer ' + options.token,
            'Content-Type': 'application/json',
          },
          body ? { 'Content-Length': Buffer.byteLength(body) } : {},
        ),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            /* 非 JSON（如网关错误页）时保留原文，交给下面报错 */
          }
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求 Cloudflare 超时（30s）')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 统一拆包：成功返回 result，失败抛带 Cloudflare 错误码的 Error */
async function call(method, apiPath, opts) {
  const res = await request(method, apiPath, opts);
  if (res.status >= 200 && res.status < 300 && res.json && res.json.success) {
    return res.json.result;
  }
  const errs = (res.json && res.json.errors) || [];
  const msg =
    errs.map((e) => '[' + e.code + '] ' + e.message).join('; ') ||
    'HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 200);
  const err = new Error(msg);
  err.status = res.status;
  err.cfErrors = errs;
  throw err;
}

/* ------------------------------------------------------------ 具体接口 */

function verifyToken(token) {
  return call('GET', '/user/tokens/verify', { token });
}

function getZone(token, zoneID) {
  return call('GET', '/zones/' + zoneID, { token });
}

function listTunnels(token, accountID) {
  return call('GET', '/accounts/' + accountID + '/cfd_tunnel?is_deleted=false', { token });
}

/**
 * 建隧道。config_src 用 'local'：路由规则由我们项目内的 config.yml 决定，
 * 不去读 Cloudflare 侧配置，这样「配置文件跟着项目走」的模型才成立。
 * （个别旧版 API 不认这个字段，上层会去掉它重试。）
 */
function createTunnel(token, accountID, name, secretB64, withConfigSrc) {
  const body = { name, tunnel_secret: secretB64 };
  if (withConfigSrc !== false) body.config_src = 'local';
  return call('POST', '/accounts/' + accountID + '/cfd_tunnel', { token, body });
}

function listDnsRecords(token, zoneID, name) {
  return call(
    'GET',
    '/zones/' + zoneID + '/dns_records?per_page=100&name=' + encodeURIComponent(name),
    { token },
  );
}

function createDnsRecord(token, zoneID, record) {
  return call('POST', '/zones/' + zoneID + '/dns_records', { token, body: record });
}

function updateDnsRecord(token, zoneID, id, record) {
  return call('PUT', '/zones/' + zoneID + '/dns_records/' + id, { token, body: record });
}

/** 生成隧道密钥：必须是 32 字节随机数的 base64（与 cloudflared 本地凭据文件一致） */
function newTunnelSecret() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = {
  parseCertToken,
  verifyToken,
  getZone,
  listTunnels,
  createTunnel,
  listDnsRecords,
  createDnsRecord,
  updateDnsRecord,
  newTunnelSecret,
};
