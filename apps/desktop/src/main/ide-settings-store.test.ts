import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeSettingsStore, defaultIdeSettings, normalizeIdeSettings } from './ide-settings-store.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('IdeSettingsStore', () => {
  it('loads defaults when the settings file is missing', async () => {
    const store = new IdeSettingsStore(join(await tempDir(), 'data', 'ide-settings.json'));

    await expect(store.load()).resolves.toEqual(defaultIdeSettings);
  });

  it('saves editor and terminal settings for later IDE sessions', async () => {
    const store = new IdeSettingsStore(await tempSettingsPath());

    const saved = await store.save({
      appearance: { language: 'en', theme: 'light', density: 'comfortable' },
      editor: { fontFamily: 'Fira Code', fontSize: 15, tabSize: 4, wordWrap: 'off', minimap: true, lineNumbers: false },
      terminal: { defaultShell: 'pwsh.exe', fontFamily: 'Cascadia Mono', fontSize: 14, scrollback: 8000, cursorBlink: false },
    });

    await expect(store.load()).resolves.toEqual(saved);
    expect(saved.editor.fontFamily).toBe('Fira Code');
    expect(saved.terminal.defaultShell).toBe('pwsh.exe');
  });

  it('returns defaults for corrupt JSON so startup can continue', async () => {
    const filePath = await tempSettingsPath();
    await writeFile(filePath, '{ broken', 'utf8');

    await expect(new IdeSettingsStore(filePath).load()).resolves.toEqual(defaultIdeSettings);
  });

  it('normalizes invalid settings into supported IDE ranges', () => {
    const normalized = normalizeIdeSettings({
      appearance: { language: 'zh-CN', theme: 'dark', density: 'compact' },
      editor: { fontFamily: '', fontSize: 200, tabSize: 1, wordWrap: 'off', minimap: true, lineNumbers: true },
      terminal: { defaultShell: '  ', fontFamily: '', fontSize: 1, scrollback: 5, cursorBlink: true },
    });

    expect(normalized.editor.fontFamily).toBe(defaultIdeSettings.editor.fontFamily);
    expect(normalized.editor.fontSize).toBe(28);
    expect(normalized.editor.tabSize).toBe(2);
    expect(normalized.terminal.defaultShell).toBe('');
    expect(normalized.terminal.fontSize).toBe(10);
    expect(normalized.terminal.scrollback).toBe(1000);
  });
});

async function tempSettingsPath(): Promise<string> {
  const filePath = join(await tempDir(), 'data', 'ide-settings.json');
  await mkdir(dirname(filePath), { recursive: true });
  return filePath;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-ide-settings-'));
  tempDirs.push(dir);
  return dir;
}
