import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Spin, Tag, Typography, message } from 'antd';
import {
  ArrowLeftOutlined, CheckCircleFilled, CloudUploadOutlined, FolderOutlined,
  LinkOutlined, SettingOutlined, UserOutlined,
} from '@ant-design/icons';

import type { CloudPushConfig } from '../types';
import {
  type CloudFolder, type CloudStatus, type CloudWebhookResult, CloudApiError,
  getCloudStatus, listCloudFolders, resolveCloudFolder, startCloudOAuth, uploadToCloud, verifyCloudFolder,
} from '../services/cloudApi';
import CloudPushSetting from './CloudPushSetting';

const { Text, Paragraph } = Typography;

const LAST_FOLDER_KEY = 'feishuprint.cloud.lastFolder';
// 用链接打开过的共享文件夹，本地记成「常用共享位置」，下次一键进入，不必再复制链接
const SHARED_ROOTS_KEY = 'feishuprint.cloud.sharedRoots';
const MAX_SHARED_ROOTS = 8;

interface SharedRoot {
  token: string;
  name: string;
}

function readSharedRoots(): SharedRoot[] {
  try {
    const s = localStorage.getItem(SHARED_ROOTS_KEY);
    const arr = s ? JSON.parse(s) : [];
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.token === 'string' && typeof x.name === 'string')
      : [];
  } catch (e) {
    return [];
  }
}

function writeSharedRoots(list: SharedRoot[]) {
  try {
    localStorage.setItem(SHARED_ROOTS_KEY, JSON.stringify(list.slice(0, MAX_SHARED_ROOTS)));
  } catch (e) { /* 隐私模式忽略 */ }
}

export interface PreparedFile {
  blob: Blob;
  fileName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // 由打印页提供：产出待推送的文档与文件名（复用「下载」同一套生成+命名逻辑）
  prepare: () => Promise<PreparedFile | null>;
  // 当前多维表格 baseId —— 推送通知配置按它独立保存
  baseId?: string | null;
  // 当前多维表格已保存的通知配置（undefined = 走默认/全局回退）
  cloudPushConfig?: CloudPushConfig;
  onSaveCloudPush?: (cfg: CloudPushConfig) => Promise<void>;
}

function readLastFolder(): { token: string; name: string } | null {
  try {
    const s = localStorage.getItem(LAST_FOLDER_KEY);
    const v = s ? JSON.parse(s) : null;
    return v && typeof v.token === 'string' ? v : null;
  } catch (e) {
    return null;
  }
}

function writeLastFolder(v: { token: string; name: string }) {
  try { localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
}

export default function PushCloudModal({
  open, onClose, prepare, baseId, cloudPushConfig, onSaveCloudPush,
}: Props) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [waitingAuth, setWaitingAuth] = useState(false);

  // 文件夹浏览：栈底固定为当前浏览起点（默认「我的空间」，可切成共享文件夹）
  const MY_SPACE = { token: '', name: '我的空间' };
  const [root, setRoot] = useState<{ token: string; name: string }>(MY_SPACE);
  const [stack, setStack] = useState<{ token: string; name: string }[]>([MY_SPACE]);
  const [link, setLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [sharedRoots, setSharedRoots] = useState<SharedRoot[]>([]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{
    name: string;
    url: string;
    folder: string;
    pusher?: string;
    webhook?: CloudWebhookResult;
  } | null>(null);
  const [lastFolder, setLastFolder] = useState<{ token: string; name: string } | null>(null);

  const [settingOpen, setSettingOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const current = stack[stack.length - 1];

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setWaitingAuth(false);
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      // 带上 baseId，服务端才能按「当前多维表格」的独立配置判断通知是否已配置
      const s = await getCloudStatus(baseId || undefined);
      setStatus(s);
      return s;
    } catch (e: any) {
      setStatus(null);
      setListError(e?.message || '无法连接本地服务，请确认服务已启动');
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, [baseId]);

  // 打开时重置并拉状态
  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    setResult(null);
    setListError(null);
    setRoot({ token: '', name: '我的空间' });
    setStack([{ token: '', name: '我的空间' }]);
    setLink('');
    setSharedRoots(readSharedRoots());
    setLastFolder(readLastFolder());
    refreshStatus();
    return stopPolling;
  }, [open, refreshStatus, stopPolling]);

  // 已授权时按当前文件夹拉子文件夹
  useEffect(() => {
    if (!open || !status?.authorized) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    listCloudFolders(current.token)
      .then((list) => { if (!cancelled) setFolders(list); })
      .catch((e: any) => {
        if (cancelled) return;
        setFolders([]);
        setListError(e?.message || '读取文件夹失败');
        // 401 = 令牌彻底失效（含 refresh 过期）→ 立刻切回「重新授权」界面，
        // 否则界面会停在「已授权」却没有重新授权入口
        if (e instanceof CloudApiError && e.status === 401) refreshStatus();
      })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [open, status?.authorized, current.token, refreshStatus]);

  const handleAuthorize = async () => {
    try {
      const { authorizeUrl } = await startCloudOAuth();
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      setWaitingAuth(true);
      message.info('已打开飞书授权页，授权完成后请回到本窗口');
      if (pollRef.current) clearInterval(pollRef.current);
      let ticks = 0;
      pollRef.current = setInterval(async () => {
        ticks += 1;
        const s = await getCloudStatus().catch(() => null);
        if (s?.authorized) {
          stopPolling();
          setStatus(s);
          message.success('飞书账号已授权');
        } else if (ticks >= 150) {
          // 5 分钟未完成则停止轮询，避免长期空转
          stopPolling();
        }
      }, 2000);
    } catch (e: any) {
      message.error(e?.message || '获取授权链接失败');
    }
  };

  const handleUpload = async () => {
    if (uploading) return;
    setUploading(true);
    setResult(null);
    try {
      // 提前校验目标文件夹可写，把权限问题挡在生成文档之前
      await verifyCloudFolder(current.token);

      const prepared = await prepare();
      if (!prepared) {
        setUploading(false);
        return;
      }
      const r = await uploadToCloud(
        prepared.blob, prepared.fileName, current.token, current.name, baseId || undefined
      );
      setResult({
        name: r.name || prepared.fileName,
        url: r.url || '',
        folder: current.name,
        pusher: r.pusher,
        webhook: r.webhook,
      });
      writeLastFolder({ token: current.token, name: current.name });
      setLastFolder({ token: current.token, name: current.name });
      if (r.webhook && r.webhook.ok === false) {
        message.warning('文档已推送，但自动化通知发送失败');
      } else {
        message.success('已推送到飞书云盘');
      }
    } catch (e: any) {
      setListError(e?.message || '推送失败');
      // 授权已失效时，直接把界面切回「重新授权」，避免卡在已授权状态
      if (e instanceof CloudApiError && e.status === 401) {
        setResult(null);
        await refreshStatus();
      }
    } finally {
      setUploading(false);
    }
  };

  // 把浏览起点切到某个文件夹（我的空间 → 共享文件夹）
  const enterRoot = (r: { token: string; name: string }) => {
    setRoot({ token: r.token, name: r.name });
    setStack([{ token: r.token, name: r.name }]);
    setListError(null);
  };

  const rememberSharedRoot = (r: SharedRoot) => {
    // 去重后置顶，最多留 8 个
    const next = [r, ...readSharedRoots().filter((x) => x.token !== r.token)].slice(0, MAX_SHARED_ROOTS);
    writeSharedRoots(next);
    setSharedRoots(next);
  };

  const removeSharedRoot = (token: string) => {
    const next = readSharedRoots().filter((x) => x.token !== token);
    writeSharedRoots(next);
    setSharedRoots(next);
  };

  // 打开共享文件夹：共享文件夹不在「我的空间」清单里，只能靠粘贴链接拿到 token
  const handleOpenLink = async () => {
    const ref = link.trim();
    if (!ref) {
      message.warning('请粘贴共享文件夹的链接');
      return;
    }
    setLinkLoading(true);
    setListError(null);
    try {
      const r = await resolveCloudFolder(ref);
      enterRoot({ token: r.folderToken, name: r.name });
      rememberSharedRoot({ token: r.folderToken, name: r.name });
      setLink('');
      message.success(`已打开「${r.name}」`);
    } catch (e: any) {
      setListError(e?.message || '打开文件夹失败');
    } finally {
      setLinkLoading(false);
    }
  };

  const resetRoot = () => {
    setRoot({ token: '', name: '我的空间' });
    setStack([{ token: '', name: '我的空间' }]);
    setListError(null);
  };

  // ===== 渲染分区 =====

  const renderStatusArea = () => {
    if (statusLoading && !status) {
      return <div style={{ textAlign: 'center', padding: '32px 0' }}><Spin /></div>;
    }
    if (!status) {
      return (
        <Alert
          type="error"
          showIcon
          message={listError || '无法连接本地服务'}
          description="云文档推送依赖本地常驻服务的 /api/cloud 接口，请确认服务已启动。"
          action={<Button size="small" onClick={refreshStatus}>重试</Button>}
        />
      );
    }
    if (!status.configured) {
      return (
        <Alert
          type="warning"
          showIcon
          message="尚未配置飞书应用"
          description={
            <div style={{ fontSize: 12, lineHeight: 1.8 }}>
              <div>{status.hint || '请在服务端填入飞书应用凭证。'}</div>
              <div style={{ marginTop: 6 }}>
                步骤：复制 <Text code>server/feishuConfig.example.json</Text> 为{' '}
                <Text code>server/feishuConfig.json</Text>，填入 App ID / App Secret，
                并确保 <Text code>redirectUri</Text> 与开放平台「安全设置 → 重定向 URL」完全一致。
              </div>
              <div style={{ marginTop: 6 }}>改动凭证后需重启服务端生效。</div>
            </div>
          }
          action={<Button size="small" onClick={refreshStatus}>重新检测</Button>}
        />
      );
    }
    if (!status.authorized) {
      const expired = !!status.authExpired;
      return (
        <div>
          <Alert
            type={expired ? 'warning' : 'info'}
            showIcon
            message={expired ? '飞书授权已过期，需要重新授权' : '需要先授权飞书账号'}
            description={
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                {expired ? (
                  <div>
                    授权凭证已失效（超过 30 天未使用）
                    {status.user?.name ? `，上次授权账号：${status.user.name}` : ''}。
                    重新授权后即可继续推送，已保存的推送位置不受影响。
                  </div>
                ) : (
                  <div>以<Text strong>你本人的身份</Text>上传，文件归属你自己、存进你自己的云盘，无需把文件夹共享给任何应用。</div>
                )}
                <div style={{ marginTop: 6 }}>
                  回调地址：<Text code>{status.redirectUri}</Text>
                </div>
              </div>
            }
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button type="primary" icon={<UserOutlined />} onClick={handleAuthorize}>
              {expired ? '重新授权' : '去飞书授权'}
            </Button>
            {waitingAuth && (
              <>
                <Spin size="small" />
                <Text type="secondary" style={{ fontSize: 12 }}>等待授权完成…</Text>
              </>
            )}
            <Button size="small" type="link" onClick={refreshStatus}>已完成，刷新状态</Button>
          </div>
        </div>
      );
    }
    return null;
  };

  const renderBrowser = () => {
    if (!status?.authorized) return null;
    return (
      <div>
        {/* 当前账号 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <UserOutlined style={{ color: '#8f959e' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前账号：{status.user?.name || '已授权'}
          </Text>
          <Tag color="green" style={{ marginLeft: 'auto', fontSize: 11 }}>已授权</Tag>
        </div>

        {/* 面包屑 */}
        <div
          style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2,
            fontSize: 12, marginBottom: 8, minHeight: 22,
          }}
        >
          {stack.map((seg, i) => (
            <React.Fragment key={`${seg.token}-${i}`}>
              {i > 0 && <Text type="secondary">/</Text>}
              <a
                onClick={() => { if (i < stack.length - 1) setStack(stack.slice(0, i + 1)); }}
                style={{
                  color: i === stack.length - 1 ? '#1f2329' : '#3370FF',
                  fontWeight: i === stack.length - 1 ? 600 : 400,
                  cursor: i === stack.length - 1 ? 'default' : 'pointer',
                }}
              >
                {seg.name}
              </a>
            </React.Fragment>
          ))}
        </div>

        {/* 共享文件夹入口：共享文件夹不在「我的空间」清单里，只能靠链接进入 */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <Input
            size="small"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onPressEnter={handleOpenLink}
            placeholder="粘贴共享文件夹链接，直接进入…"
            allowClear
            prefix={<LinkOutlined style={{ color: '#8f959e' }} />}
          />
          <Button size="small" onClick={handleOpenLink} loading={linkLoading}>打开</Button>
          {root.token && (
            <Button size="small" type="link" style={{ padding: 0, flexShrink: 0 }} onClick={resetRoot}>
              回我的空间
            </Button>
          )}
        </div>

        {/* 常用共享位置：用链接打开过一次后就记住，下次一键进入，不用再复制链接 */}
        {sharedRoots.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>常用共享位置：</Text>
            {sharedRoots.map((r) => (
              <Tag
                key={r.token}
                closable
                color={root.token === r.token ? 'blue' : undefined}
                onClick={() => enterRoot(r)}
                onClose={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeSharedRoot(r.token);
                }}
                style={{ cursor: 'pointer', marginInlineEnd: 0, fontSize: 12 }}
              >
                {r.name}
              </Tag>
            ))}
          </div>
        )}

        {/* 上次推送位置快捷入口 */}
        {lastFolder && lastFolder.token !== current.token && (
          <div style={{ marginBottom: 8 }}>
            <Button
              size="small"
              type="link"
              style={{ padding: 0, fontSize: 12 }}
              icon={<CloudUploadOutlined />}
              disabled={uploading}
              onClick={() => setStack([{ token: '', name: '我的空间' }, lastFolder])}
            >
              回到上次推送位置：{lastFolder.name}
            </Button>
          </div>
        )}

        {/* 文件夹列表 */}
        <div
          style={{
            border: '1px solid #e5e6eb', borderRadius: 8, height: 240,
            overflow: 'auto', background: '#fff',
          }}
        >
          {stack.length > 1 && (
            <div
              onClick={() => setStack(stack.slice(0, stack.length - 1))}
              style={rowStyle}
            >
              <ArrowLeftOutlined style={{ color: '#8f959e' }} />
              <span style={{ color: '#3370FF' }}>返回上级</span>
            </div>
          )}
          {listLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 0' }}><Spin /></div>
          ) : folders.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span style={{ fontSize: 12 }}>此文件夹下没有子文件夹</span>}
              style={{ marginTop: 56 }}
            />
          ) : (
            folders.map((f) => (
              <div
                key={f.token}
                style={rowStyle}
                onClick={() => setStack([...stack, { token: f.token, name: f.name }])}
              >
                <FolderOutlined style={{ color: '#FFB400' }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </span>
                <Text type="secondary" style={{ fontSize: 11 }}>进入</Text>
              </div>
            ))
          )}
        </div>

        {listError && (
          <Alert type="error" showIcon style={{ marginTop: 10 }} message={listError} />
        )}

        {/* 结果 */}
        {result && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            style={{ marginTop: 10 }}
            message={`已推送到「${result.folder}」`}
            description={
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                <div>文件名：{result.name}</div>
                {result.pusher && <div>推送人：{result.pusher}</div>}
                {result.url && (
                  <a href={result.url} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 在飞书中打开
                  </a>
                )}
                {result.webhook?.ok === true && (
                  <div style={{ marginTop: 6, color: '#237804' }}>已发送自动化通知</div>
                )}
                {result.webhook?.ok === false && (
                  <div style={{ marginTop: 6, color: '#d4380d' }}>{result.webhook.error}</div>
                )}
              </div>
            }
          />
        )}

        {/* 通知状态 */}
        <div style={{ marginTop: 8, fontSize: 12, color: '#8f959e' }}>
          {status?.webhookConfigured
            ? '推送成功后将发送自动化通知'
            : cloudPushConfig?.enabled
            ? '已启用通知，但 Webhook 地址为空，不会发送'
            : '未启用自动化通知（点右上角「通知设置」可开启）'}
        </div>

        {/* 操作 */}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
            推送位置：<Text strong style={{ fontSize: 12 }}>{stack.map((s) => s.name).join(' / ')}</Text>
          </Text>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            loading={uploading}
            onClick={handleUpload}
          >
            推送到此文件夹
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <Modal
        open={open}
        onCancel={() => { if (!uploading) onClose(); }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 24 }}>
            <CloudUploadOutlined style={{ color: '#3370FF' }} />
            <span>推送云文档</span>
            <Button
              size="small"
              type="link"
              icon={<SettingOutlined />}
              style={{ marginLeft: 'auto', padding: 0, fontSize: 12 }}
              onClick={() => setSettingOpen(true)}
            >
              通知设置
            </Button>
          </div>
        }
        width={520}
        maskClosable={!uploading}
        footer={null}
      >
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          把当前记录生成的文档（与「下载」同一份内容）推送到飞书云盘的指定文件夹。推送不影响本地打印。
        </Paragraph>

        {/* 服务端版本探测：新字段缺失 = 服务端代码没生效（多半是没重启） */}
        {status && status.authExpired === undefined && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="服务端版本较旧，部分功能不可用"
            description={
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                服务端没有返回新字段（授权过期判断、默认模板、通知配置均会失效）。
                通常是 <Text code>server/*.js</Text> 更新后**没有重启 dev server** ——
                需先结束占用 5173 的旧进程再启动。
              </div>
            }
          />
        )}

        {renderStatusArea()}
        {renderBrowser()}
      </Modal>

      <CloudPushSetting
        open={settingOpen}
        onClose={() => setSettingOpen(false)}
        baseId={baseId || null}
        config={cloudPushConfig}
        defaultTemplate={status?.defaultBodyTemplate}
        statusReady={!!status}
        templateVars={status?.templateVars}
        onSave={async (cfg) => {
          if (!onSaveCloudPush) throw new Error('当前页面不支持保存通知设置');
          await onSaveCloudPush(cfg);
          // 保存后刷新：让「通知状态」那行与后续推送立即生效
          await refreshStatus();
        }}
      />
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 12px',
  borderBottom: '1px solid #f2f3f5',
  fontSize: 13,
  cursor: 'pointer',
  userSelect: 'none',
};
