import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigProvider, Spin, Alert, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';

import type { TemplateInfo, MatchConfig } from './types';
import { listTemplates, getConfig } from './services/templateApi';
import { useActiveRecord } from './hooks/useActiveRecord';
import PrintTab from './components/PrintTab';
import TemplateManageTab from './components/TemplateManageTab';
import TemplateEditorTab from './components/TemplateEditorTab';
import StampManageTab from './components/StampManageTab';
import VariablePanel from './components/VariablePanel';
import { createRequestGate } from './services/requestGate';

const THEME = {
  token: {
    colorPrimary: '#3370FF',
    colorInfo: '#3370FF',
    borderRadius: 6,
    colorBgLayout: '#f5f6f7',
    colorBorderSecondary: '#e5e6eb',
    fontSize: 13,
  },
  components: {
    Card: { headerFontSize: 14, paddingLG: 12 },
    Segmented: { itemSelectedBg: '#3370FF', itemSelectedColor: '#fff' },
  },
};

const TABS = [
  { key: 'print', label: '打印', icon: '🖨' },
  { key: 'manage', label: '模板', icon: '📁' },
  { key: 'edit', label: '编辑', icon: '✏️' },
  { key: 'stamp', label: '印章', icon: '🔏' },
  { key: 'vars', label: '变量', icon: '🏷' },
] as const;

export default function App() {
  const active = useActiveRecord();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [matchConfig, setMatchConfig] = useState<MatchConfig>({ tables: {} });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string>('print');
  const templateLoadGateRef = useRef(createRequestGate());
  const activeTableIdRef = useRef(active.tableId);
  activeTableIdRef.current = active.tableId;

  const refreshTemplates = useCallback(async () => {
    const tableId = active.tableId;
    const ticket = templateLoadGateRef.current.start();
    if (!tableId) {
      setTemplates([]);
      return;
    }
    try {
      const list = await listTemplates(tableId);
      if (!ticket.isCurrent() || activeTableIdRef.current !== tableId) return;
      setTemplates(list);
      setLoadError(null);
    } catch (e: any) {
      if (!ticket.isCurrent() || activeTableIdRef.current !== tableId) return;
      setLoadError('无法连接本地模板服务：' + (e?.message || e));
    }
  }, [active.tableId]);

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setMatchConfig(cfg);
    } catch (e) {
      // 配置读取失败不阻塞界面
    }
  }, []);

  useEffect(() => {
    templateLoadGateRef.current.invalidate();
    setTemplates([]);
    refreshTemplates();
    return () => templateLoadGateRef.current.invalidate();
  }, [active.tableId, refreshTemplates]);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  return (
    <ConfigProvider locale={zhCN} theme={THEME}>
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: THEME.token.colorBgLayout,
        }}
      >
        {/* ===== 顶部状态条 ===== */}
        <div
          style={{
            background: '#fff',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: '1px solid #e5e6eb',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: active.recordId ? '#34c724' : '#ff8800',
              flexShrink: 0,
            }}
          />
          <div
            style={{
              fontSize: 13,
              color: '#1f2329',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
            }}
          >
            {active.primaryText || '请在左侧表格中选中一条记录'}
          </div>
          <div style={{ fontSize: 12, color: '#8f959e', flexShrink: 0 }}>
            {active.tableName || ''}
          </div>
        </div>

        {/* ===== 内容区 ===== */}
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {loadError && (
            <Alert
              type="warning"
              showIcon
              style={{ margin: 12, borderRadius: 8, flexShrink: 0 }}
              message={loadError}
              description="模板功能依赖本地 dev server 的 /api 接口，请确认服务已启动。"
            />
          )}
          {active.loading ? (
            <div style={{ textAlign: 'center', paddingTop: 96, flex: 1 }}>
              <Spin size="large" />
              <div style={{ marginTop: 16, color: '#8c8c8c', fontSize: 13 }}>
                正在连接多维表格…
              </div>
            </div>
          ) : (
            <>
              {activeKey === 'print' && (
                <PrintTab
                  active={active}
                  templates={templates}
                  matchConfig={matchConfig}
                  onNeedTemplates={refreshTemplates}
                  goManage={() => setActiveKey('manage')}
                  goStamp={() => setActiveKey('stamp')}
                />
              )}
              {activeKey === 'manage' && (
                <TemplateManageTab
                  active={active}
                  templates={templates}
                  matchConfig={matchConfig}
                  onTemplatesChanged={refreshTemplates}
                  onConfigChanged={(cfg) => setMatchConfig(cfg)}
                />
              )}
              {activeKey === 'edit' && (
                <TemplateEditorTab
                  active={active}
                  templates={templates}
                  onTemplatesChanged={refreshTemplates}
                />
              )}
              {activeKey === 'stamp' && <StampManageTab active={active} />}
              {activeKey === 'vars' && <VariablePanel active={active} />}
            </>
          )}
        </div>

        {/* ===== 底部 Tab 导航 ===== */}
        <div
          style={{
            display: 'flex',
            background: '#fff',
            borderTop: '1px solid #e5e6eb',
            flexShrink: 0,
          }}
        >
          {TABS.map((t) => {
            const on = activeKey === t.key;
            return (
              <div
                key={t.key}
                onClick={() => setActiveKey(t.key)}
                style={{
                  flex: 1,
                  padding: '8px 0 10px',
                  textAlign: 'center',
                  fontSize: 11,
                  color: on ? '#3370FF' : '#8f959e',
                  fontWeight: on ? 600 : 400,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 3,
                  userSelect: 'none',
                  transition: 'color .15s',
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>{t.icon}</span>
                {t.label}
              </div>
            );
          })}
        </div>
      </div>
    </ConfigProvider>
  );
}
