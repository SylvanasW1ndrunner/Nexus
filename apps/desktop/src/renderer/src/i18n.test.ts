import { describe, expect, it } from 'vitest';
import { createTranslator, normalizeLanguage } from './i18n.js';

describe('renderer i18n', () => {
  it('defaults to Chinese and supports English switching', () => {
    expect(normalizeLanguage(undefined)).toBe('zh-CN');
    expect(normalizeLanguage('fr')).toBe('zh-CN');
    expect(normalizeLanguage('en')).toBe('en');

    expect(createTranslator('zh-CN')('project')).toBe('项目');
    expect(createTranslator('en')('project')).toBe('Project');
  });
});
