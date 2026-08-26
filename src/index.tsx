import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// 清除旧版（整表导出/打印）遗留的 localStorage 预设，避免混淆
try {
  localStorage.removeItem('export_print_prefs_v1');
  localStorage.removeItem('export_print_templates_v1');
} catch (e) {
  // 忽略隐私模式等无法访问 localStorage 的情况
}

// 让预览区的 Spin 包裹容器撑满高度，使预览滚动区正确占满剩余空间
const style = document.createElement('style');
style.textContent = `
.preview-spin, .preview-spin .ant-spin-container { width: 100%; height: 100%; }
`;
document.head.appendChild(style);

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
