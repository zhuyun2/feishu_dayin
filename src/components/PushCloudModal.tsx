import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import {
  ArrowLeftOutlined, CheckCircleFilled, CloudUploadOutlined, FolderOutlined,
  LinkOutlined, UserOutlined,
} from '@ant-design/icons';

import {
  type CloudFolder, type CloudStatus, getCloudStatus, listCloudFolders,
  startCloudOAuth, uploadToCloud, verifyCloudFolder,
} from '../services/cloudApi';

const { Text, Paragraph } = Typography;

const LAST_FOLDER_KEY = 'feishuprint.cloud.lastFolder';

export interface PreparedFile {
  blob: Blob;
  fileName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // 由打印页提供：产出待推送的文档与文件名（复用「下载」同一套生成+命名逻辑）
  prepare: () => Promise<PreparedFile | null>;
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

export default function PushCloudModal({ open, onClose, prepare }: Props) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [waitingAuth, setWaitingAuth] = useState(false);

  // 文件夹浏览：栈底固定为根目录「我的空间」
  const [stack, setStack] = useState<{ token: string; name: string }[]>([{ token: '', name: '我的空间' }]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ name: string; url: string; folder: string } | null>(null);
  const [lastFolder, setLastFolder] = useState<{ token: string; name: string } | null>(null);

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
      const s = await getCloudStatus();
      setStatus(s);
      return s;
    } catch (e: any) {
      setStatus(null);
      setListError(e?.message || '无法连接本地服务，请确认服务已启动');
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // 打开时重置并拉状态
  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    setResult(null);
    setListError(null);
    setStack([{ token: '', name: '我的空间' }]);
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
      })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [open, status?.authorized, current.token]);

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
      const r = await uploadToCloud(prepared.blob, prepared.fileName, current.token);
      setResult({ name: r.name || prepared.fileName, url: r.url || '', folder: current.name });
      writeLastFolder({ token: current.token, name: current.name });
      setLastFolder({ token: current.token, name: current.name });
      message.success('已推送到飞书云盘');
    } catch (e: any) {
      setListError(e?.message || '推送失败');
    } finally {
      setUploading(false);
    }
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
      return (
        <div>
          <Alert
            type="info"
            showIcon
            message="需要先授权飞书账号"
            description={
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                <div>以<Text strong>你本人的身份</Text>上传，文件归属你自己、存进你自己的云盘，无需把文件夹共享给任何应用。</div>
                <div style={{ marginTop: 6 }}>
                  回调地址：<Text code>{status.redirectUri}</Text>
                </div>
              </div>
            }
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button type="primary" icon={<UserOutlined />} onClick={handleAuthorize}>
              去飞书授权
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
                {result.url && (
                  <a href={result.url} target="_blank" rel="noreferrer">
                    <LinkOutlined /> 在飞书中打开
                  </a>
                )}
              </div>
            }
          />
        )}

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
    <Modal
      open={open}
      onCancel={() => { if (!uploading) onClose(); }}
      title={
        <Space>
          <CloudUploadOutlined style={{ color: '#3370FF' }} />
          <span>推送云文档</span>
        </Space>
      }
      width={520}
      maskClosable={!uploading}
      footer={null}
    >
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
        把当前记录生成的文档（与「下载」同一份内容）推送到飞书云盘的指定文件夹。推送不影响本地打印。
      </Paragraph>
      {renderStatusArea()}
      {renderBrowser()}
    </Modal>
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
