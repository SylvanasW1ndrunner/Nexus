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
    ]);
    expect(criticalLabels.join('')).not.toMatch(/[\u951F\uFFFD\u93B5\u7481\u940E\u7F01]/);
  });
});
