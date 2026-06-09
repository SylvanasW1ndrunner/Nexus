import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IdeSettings } from '@dbagent/shared';

export const defaultIdeSettings: IdeSettings = {
  appearance: {
    language: 'zh-CN',
    theme: 'dark',
    density: 'compact',
  },
  editor: {
    fontFamily: 'JetBrains Mono, Consolas, SFMono-Regular, monospace',
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'on',
    minimap: false,
    lineNumbers: true,
  },
  terminal: {
    defaultShell: '',
    fontFamily: 'JetBrains Mono, Consolas, SFMono-Regular, monospace',
    fontSize: 13,
    scrollback: 5000,
    cursorBlink: true,
  },
};

export class IdeSettingsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<IdeSettings> {
    try {
      const settings = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<IdeSettings>;
      return normalizeIdeSettings(settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return defaultIdeSettings;
      throw error;
    }
  }

  async save(patch: Partial<IdeSettings>): Promise<IdeSettings> {
    const current = await this.load();
    const saved = normalizeIdeSettings({
      appearance: { ...current.appearance, ...patch.appearance },
      editor: { ...current.editor, ...patch.editor },
      terminal: { ...current.terminal, ...patch.terminal },
    });
    await writeJsonAtomic(this.filePath, saved);
    return saved;
  }
}

export function normalizeIdeSettings(input: Partial<IdeSettings>): IdeSettings {
  return {
    appearance: {
      language: input.appearance?.language === 'en' ? 'en' : 'zh-CN',
      theme: input.appearance?.theme === 'light' ? 'light' : 'dark',
      density: input.appearance?.density === 'comfortable' ? 'comfortable' : 'compact',
    },
    editor: {
      fontFamily: normalizeText(input.editor?.fontFamily, defaultIdeSettings.editor.fontFamily),
      fontSize: normalizeInteger(input.editor?.fontSize, 10, 28, defaultIdeSettings.editor.fontSize),
      tabSize: normalizeInteger(input.editor?.tabSize, 2, 8, defaultIdeSettings.editor.tabSize),
      wordWrap: input.editor?.wordWrap === 'off' ? 'off' : 'on',
      minimap: input.editor?.minimap === true,
      lineNumbers: input.editor?.lineNumbers !== false,
    },
    terminal: {
      defaultShell: typeof input.terminal?.defaultShell === 'string' ? input.terminal.defaultShell.trim() : '',
      fontFamily: normalizeText(input.terminal?.fontFamily, defaultIdeSettings.terminal.fontFamily),
      fontSize: normalizeInteger(input.terminal?.fontSize, 10, 28, defaultIdeSettings.terminal.fontSize),
      scrollback: normalizeInteger(input.terminal?.scrollback, 1000, 100000, defaultIdeSettings.terminal.scrollback),
      cursorBlink: input.terminal?.cursorBlink !== false,
    },
  };
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}
