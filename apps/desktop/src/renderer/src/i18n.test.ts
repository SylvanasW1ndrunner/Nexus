import { describe, expect, it } from 'vitest';
import { createTranslator, normalizeLanguage } from './i18n.js';

describe('renderer i18n', () => {
  it('defaults to Chinese and supports English switching', () => {
    expect(normalizeLanguage(undefined)).toBe('zh-CN');
    expect(normalizeLanguage('fr')).toBe('zh-CN');
    expect(normalizeLanguage('en')).toBe('en');

    expect(createTranslator('zh-CN')('project')).toBe('项目');
    expect(createTranslator('en')('project')).toBe('Project');
    expect(createTranslator('zh-CN')('pythonEnvironment')).toBe('Python 环境');
  });

  it('keeps critical Chinese workbench labels readable', () => {
    const t = createTranslator('zh-CN');
    const criticalLabels = [
      t('createProject'),
      t('openProject'),
      t('ideSettings'),
      t('projectSettings'),
      t('terminal'),
      t('pluginMarketplace'),
      t('passwordLogin'),
      t('sendCode'),
      t('commandPalette'),
      t('searchCommands'),
      t('newTerminal'),
      t('splitTerminal'),
      t('maximizePanel'),
      t('commandRunPython'),
      t('commandRunSql'),
      t('commandOpenIdeSettings'),
      t('commandToggleExplorer'),
      t('commandSourceCore'),
      t('chartPreviewRegistered'),
      t('commandNotBound'),
      t('editorSettingsHint'),
      t('densityCompact'),
      t('densityComfortable'),
      t('tabSize'),
      t('wordWrap'),
      t('lineNumbers'),
    ];

    expect(criticalLabels).toEqual([
      '新建项目',
      '打开项目',
      'IDE 设置',
      '项目设置',
      '终端',
      '插件市场',
      '账密登录',
      '发送验证码',
      '命令面板',
      '搜索命令',
      '新建终端',
      '拆分终端',
      '最大化面板',
      '运行当前 Python 文件',
      '运行当前 SQL',
      '打开 IDE 设置',
      '切换资源管理器',
      '核心',
      '图表预览插件接口已注册，运行时视图将在后续接入。',
      '命令尚未绑定处理器。',
      '配置代码字体、字号、换行、缩略图和行号显示。',
      '紧凑',
      '舒适',
      'Tab 大小',
      '自动换行',
      '行号',
    ]);
    expect(criticalLabels.join('')).not.toMatch(/[\u951F\uFFFD\u93B5\u7481\u940E\u7F01]/);
  });
});
