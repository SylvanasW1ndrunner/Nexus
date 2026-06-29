import { useEffect, useState } from 'react';
import { ipcChannels, type AuthStatus, type IdeSettings } from '@dbagent/shared';

type HealthStatus = 'checking' | 'ok' | 'failed' | 'unavailable';

type HealthState = {
  auth: HealthStatus;
  settings: HealthStatus;
  authMode?: AuthStatus['capabilities'] extends infer Capabilities
    ? Capabilities extends { mode: infer Mode }
      ? Mode
      : never
    : never;
  language?: IdeSettings['appearance']['language'];
  message?: string;
};

const initialHealth: HealthState = {
  auth: 'checking',
  settings: 'checking',
};

export function App() {
  const [health, setHealth] = useState<HealthState>(initialHealth);

  useEffect(() => {
    let cancelled = false;

    async function checkIpcHealth() {
      if (!window.dbagent) {
        if (!cancelled) {
          setHealth({
            auth: 'unavailable',
            settings: 'unavailable',
            message: '当前运行环境未暴露桌面 IPC，仅显示前端重构占位页。',
          });
        }
        return;
      }

      const [authResponse, settingsResponse] = await Promise.all([
        window.dbagent.invoke(ipcChannels.auth.status, undefined),
        window.dbagent.invoke(ipcChannels.app.loadIdeSettings, undefined),
      ]);

      if (cancelled) return;

      setHealth({
        auth: authResponse.ok ? 'ok' : 'failed',
        settings: settingsResponse.ok ? 'ok' : 'failed',
        ...(authResponse.ok && authResponse.data.capabilities ? { authMode: authResponse.data.capabilities.mode } : {}),
        ...(settingsResponse.ok ? { language: settingsResponse.data.appearance.language } : {}),
        ...(!authResponse.ok || !settingsResponse.ok ? { message: '基础 IPC 检查未完全通过，请查看主进程日志。' } : {}),
      });
    }

    void checkIpcHealth().catch((error) => {
      if (cancelled) return;
      setHealth({
        auth: 'failed',
        settings: 'failed',
        message: error instanceof Error ? error.message : '基础 IPC 检查失败。',
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="reset-shell">
      <section className="reset-panel" aria-label="DBAgent frontend reset status">
        <div className="reset-mark" aria-hidden="true">
          DB
        </div>
        <div className="reset-copy">
          <p className="reset-kicker">DBAgent Desktop</p>
          <h1>前端 UI 正在重构</h1>
          <p>
            旧 IDE 界面已经下线。当前版本只保留最小启动宿主，用于确认 Electron、preload 和核心 IPC
            仍可正常工作；新的界面会先按中文设计规格重建。
          </p>
        </div>
        <dl className="health-grid">
          <HealthItem label="认证 IPC" value={statusLabel(health.auth)} tone={health.auth} />
          <HealthItem label="设置 IPC" value={statusLabel(health.settings)} tone={health.settings} />
          <HealthItem label="认证模式" value={health.authMode ? String(health.authMode) : '未读取'} />
          <HealthItem label="界面语言" value={health.language ?? '未读取'} />
        </dl>
        {health.message ? <p className="reset-note">{health.message}</p> : null}
      </section>
    </main>
  );
}

function HealthItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: HealthStatus;
}) {
  return (
    <div className={tone ? `health-item ${tone}` : 'health-item'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusLabel(status: HealthStatus): string {
  if (status === 'checking') return '检查中';
  if (status === 'ok') return '正常';
  if (status === 'unavailable') return '不可用';
  return '失败';
}
