import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Switch, Tag, Typography, message } from 'antd';
import { CloudUploadOutlined, ExclamationCircleOutlined, SendOutlined } from '@ant-design/icons';

import type { CloudPushConfig } from '../types';
import { testAutomationWebhook, type CloudWebhookResult } from '../services/cloudApi';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

// 内置兜底模板：正常情况下由服务端 /api/cloud/status 下发 defaultBodyTemplate（唯一事实来源）。
// 但服务端未重启/版本较旧时该字段会缺失，此时用这份兜底，避免界面直接显示空 {} 让人无从下手。
const FALLBACK_BODY_TEMPLATE = [
  '{',
  '  "fileName": "{{fileName}}",',
  '  "pusher": "{{pusher}}",',
  '  "text": "{{pusher}} 推送了「{{fileName}}」到飞书云盘",',
  '  "pushedAt": "{{pushedAt}}",',
  '  "fileUrl": "{{fileUrl}}",',
  '  "folderName": "{{folderName}}"',
  '}',
].join('\n');

interface Props {
  open: boolean;
  onClose: () => void;
  baseId: string | null;
  /** 当前多维表格已保存的配置（undefined = 从未配置过，默认不启用） */
  config?: CloudPushConfig;
  /** 服务端下发的默认模板（单一事实来源，避免前后端各写一份漂移） */
  defaultTemplate?: string;
  /** 状态是否已拉回：用于区分「还没加载」和「服务端没下发」 */
  statusReady?: boolean;
  templateVars?: string[];
  onSave: (cfg: CloudPushConfig) => Promise<void>;
}

// 与服务端一致的占位符替换（仅用于本地预校验与示例渲染）
const SAMPLE: Record<string, string> = {
  fileName: '示例文件.docx',
  pusher: '张三',
  text: '张三 推送了「示例文件.docx」到飞书云盘',
  pushedAt: '2026-10-20 15:00:00',
  fileUrl: 'https://example.com/file/boxcnXXXX',
  folderName: '示例文件夹',
};

function renderSample(tpl: string): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(SAMPLE, name)
      ? JSON.stringify(SAMPLE[name]).slice(1, -1)
      : m
  );
}

// 校验模板：替换示例值后必须是合法 JSON；同时找出未知变量
function validateTemplate(tpl: string): { ok: boolean; error?: string; unknown?: string[] } {
  const unknown = Array.from(tpl.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g))
    .map((m) => m[1])
    .filter((n, i, arr) => !(n in SAMPLE) && arr.indexOf(n) === i);
  try {
    JSON.parse(renderSample(tpl));
  } catch (e: any) {
    return { ok: false, error: `替换示例值后不是合法 JSON：${e?.message || e}`, unknown };
  }
  return { ok: true, unknown };
}

export default function CloudPushSetting({
  open, onClose, baseId, config, defaultTemplate, statusReady, templateVars, onSave,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [tpl, setTpl] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CloudWebhookResult | null>(null);
  const [touched, setTouched] = useState(false);

  const effectiveDefault = defaultTemplate || FALLBACK_BODY_TEMPLATE;
  // 服务端已返回状态、却没带默认模板 → 说明服务端代码没生效（多半是没重启）
  const serverStale = !!statusReady && !defaultTemplate;

  useEffect(() => {
    if (!open) return;
    setEnabled(config?.enabled === true); // 默认不启用
    setUrl(config?.webhookUrl || '');     // 地址默认空，不预填任何历史值
    setTpl(config?.bodyTemplate || effectiveDefault);
    setTestResult(null);
    setTouched(false);
  }, [open, config?.enabled, config?.webhookUrl, config?.bodyTemplate, effectiveDefault]);

  const check = useMemo(() => validateTemplate(tpl), [tpl]);

  const urlError = touched && url.trim() !== '' && !/^https?:\/\/\S+$/i.test(url.trim())
    ? '地址需以 http:// 或 https:// 开头'
    : '';

  const handleTest = async () => {
    if (!url.trim()) {
      message.warning('请先填写 Webhook 地址');
      return;
    }
    if (!check.ok) {
      message.error('模板不是合法 JSON，先修正再测试');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testAutomationWebhook({
        baseId: baseId || '',
        webhookUrl: url.trim(),
        bodyTemplate: tpl,
      });
      setTestResult(r);
      if (r.ok) message.success('测试消息已发送');
      else message.error('测试发送失败');
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || '测试发送失败' });
      message.error(e?.message || '测试发送失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setTouched(true);
    if (url.trim() && !/^https?:\/\/\S+$/i.test(url.trim())) {
      message.error('Webhook 地址需以 http:// 或 https:// 开头');
      return;
    }
    if (!check.ok) {
      message.error('请求体模板不是合法 JSON');
      return;
    }
    setSaving(true);
    try {
      await onSave({ enabled, webhookUrl: url.trim(), bodyTemplate: tpl });
      message.success('已保存（仅对当前多维表格生效）');
      onClose();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={() => { if (!saving) onClose(); }}
      title={
        <Space>
          <CloudUploadOutlined style={{ color: '#3370FF' }} />
          <span>推送通知设置</span>
        </Space>
      }
      width={620}
      footer={null}
      maskClosable={!saving}
    >
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
        推送成功后向「多维表格自动化」发一条通知。配置<Text strong>仅对当前这个多维表格生效</Text>，
        其他多维表格可各自设置不同的地址与内容。
      </Paragraph>

      {!baseId && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未获取到多维表格标识"
          description="请在飞书多维表格内以插件方式打开后再设置，否则无法按多维表格保存独立配置。"
        />
      )}

      {serverStale && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="服务端未下发默认模板 —— 服务端代码没生效"
          description={
            <div style={{ fontSize: 12, lineHeight: 1.8 }}>
              <div>已用内置模板兜底，但这种状态下保存的配置不会真正写入/生效。</div>
              <div style={{ marginTop: 4 }}>
                请重启该机器的 dev server：先结束占用 <Text code>5173</Text> 的进程再启动。
                不先结束的话，「一键部署」会复用旧进程，<Text code>server/*.js</Text> 的改动不会生效。
              </div>
            </div>
          }
        />
      )}

      {/* 启用开关：默认关闭 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <Switch checked={enabled} onChange={setEnabled} style={{ marginTop: 2 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>启用推送通知</div>
          <div style={{ fontSize: 12, color: '#8f959e' }}>
            {enabled ? '已启用：推送成功后会向下面的地址发送通知' : '未启用：推送后不会发送任何通知'}
          </div>
        </div>
      </div>

      {enabled && !url.trim() && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="已启用，但 Webhook 地址为空 —— 不会发送通知"
          description="地址为空时即使启用也不会推送。填入地址并保存后才会生效。"
        />
      )}

      {/* Webhook 地址 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Webhook 地址</div>
        <Input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setTouched(true); }}
          placeholder="https://xxx.feishu.cn/base/automation/webhook/event/xxxxxxxx"
          allowClear
          status={urlError ? 'error' : undefined}
        />
        {urlError ? (
          <div style={{ fontSize: 12, color: '#f5222d', marginTop: 4 }}>{urlError}</div>
        ) : (
          <div style={{ fontSize: 12, color: '#8f959e', marginTop: 4 }}>
            多维表格 → 自动化 → 选「接收到 webhook 时」触发 → 复制该节点的 Webhook 地址。留空表示推送后不发送通知。
          </div>
        )}
      </div>

      {/* 请求体模板 */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>请求体模板（JSON）</span>
          <Button
            size="small"
            type="link"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => { setTpl(effectiveDefault); setTestResult(null); }}
          >
            恢复默认模板
          </Button>
        </div>
        <TextArea
          value={tpl}
          onChange={(e) => setTpl(e.target.value)}
          autoSize={{ minRows: 8, maxRows: 16 }}
          style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 12 }}
          spellCheck={false}
        />
        <div style={{ fontSize: 12, color: '#8f959e', marginTop: 4 }}>
          占位符要写在 JSON 字符串里，例如 <Text code>{'"fileName": "{{fileName}}"'}</Text>。
          支持变量：
          {(templateVars || Object.keys(SAMPLE)).map((v) => (
            <Tag key={v} style={{ marginLeft: 4, fontSize: 11, fontFamily: 'monospace' }}>{`{{${v}}}`}</Tag>
          ))}
        </div>
      </div>

      {/* 模板校验结果 */}
      {!check.ok && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message="模板校验未通过"
          description={check.error}
        />
      )}
      {check.ok && check.unknown && check.unknown.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          style={{ marginTop: 8 }}
          message="存在未知变量，发送时会原样保留"
          description={check.unknown.map((v) => `{{${v}}}`).join('、')}
        />
      )}

      {/* 测试结果 */}
      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          style={{ marginTop: 8 }}
          message={testResult.ok ? '测试消息已发送，请到多维表格自动化里查看运行记录' : (testResult.error || '测试发送失败')}
        />
      )}

      <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Button icon={<SendOutlined />} onClick={handleTest} loading={testing}>
          测试发送
        </Button>
        <Button onClick={onClose} disabled={saving}>取消</Button>
        <Button type="primary" onClick={handleSave} loading={saving}>保存</Button>
      </div>
    </Modal>
  );
}
