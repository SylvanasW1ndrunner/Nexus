import type { SkillDefinition, SkillSource } from './types.js';

type RawSkill = Record<string, unknown>;

export function parseSkillDefinition(
  content: string,
  source: SkillSource,
  sourcePath?: string,
  bundleRoot?: string,
): SkillDefinition {
  return normalizeSkill(parseStructuredSkill(content), source, sourcePath, bundleRoot);
}

export function parseSkillDocument(
  content: string,
  source: SkillSource,
  sourcePath?: string,
  bundleRoot?: string,
): SkillDefinition {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!match) {
    throw new Error('SKILL.md must start with YAML front matter delimited by "---".');
  }
  const raw = parseStructuredSkill(match[1] ?? '');
  const instructions = (match[2] ?? '').trim();
  if (instructions && raw.system_addition === undefined && raw.systemAddition === undefined) {
    raw.system_addition = instructions;
  }
  return normalizeSkill(raw, source, sourcePath, bundleRoot);
}

export function parseStructuredSkill(content: string): RawSkill {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Skill file is empty.');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as RawSkill;
  return parseYamlSubset(trimmed);
}

function normalizeSkill(
  raw: RawSkill,
  source: SkillSource,
  sourcePath?: string,
  bundleRoot?: string,
): SkillDefinition {
  const name = requiredName(raw.name);
  const description = requiredString(raw.description, 'description');
  const title = optionalString(raw.title);
  const version = optionalString(raw.version);
  const author = optionalString(raw.author);
  const systemAddition = optionalString(raw.system_addition ?? raw.systemAddition);
  return {
    name,
    ...(title === undefined ? {} : { title }),
    description,
    ...(version === undefined ? {} : { version }),
    ...(author === undefined ? {} : { author }),
    tags: stringArray(raw.tags, 'tags'),
    ...(systemAddition === undefined ? {} : { systemAddition }),
    allowedTools: unique(stringArray(raw.allowed_tools ?? raw.allowedTools, 'allowed_tools')),
    defaults: normalizeDefaults(raw.defaults),
    steps: stringArray(raw.steps, 'steps'),
    outputFormat: normalizeOutputFormat(raw.output_format ?? raw.outputFormat),
    naturalLanguageKeywords: unique(
      stringArray(
        raw.natural_language_keywords ?? raw.naturalLanguageKeywords,
        'natural_language_keywords',
      ),
    ),
    autoInjectWhen: unique(
      stringArray(raw.auto_inject_when ?? raw.autoInjectWhen, 'auto_inject_when'),
    ),
    source,
    ...(sourcePath ? { sourcePath } : {}),
    ...(bundleRoot ? { bundleRoot } : {}),
  };
}

function parseYamlSubset(content: string): RawSkill {
  const root: RawSkill = {};
  let currentKey: string | undefined;
  let blockKey: string | undefined;
  let blockValue: string[] = [];

  const flushBlock = () => {
    if (!blockKey) return;
    while (blockValue.at(-1) === '') blockValue.pop();
    root[blockKey] = blockValue.join('\n');
    blockKey = undefined;
    blockValue = [];
  };

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = stripComment(rawLine);
    if (!line.trim()) {
      if (blockKey) blockValue.push('');
      continue;
    }
    if (blockKey && /^\s+/.test(rawLine)) {
      blockValue.push(rawLine.replace(/^\s{2}/, ''));
      continue;
    }
    flushBlock();

    const keyValue = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (keyValue?.[1]) {
      currentKey = keyValue[1];
      const value = keyValue[2] ?? '';
      if (value === '|') {
        blockKey = currentKey;
      } else if (value === '') {
        root[currentKey] = [];
      } else {
        root[currentKey] = parseScalarOrInlineArray(value);
      }
      continue;
    }

    const item = line.match(/^\s*-\s*(.*)$/);
    if (item && currentKey) {
      const list = Array.isArray(root[currentKey]) ? (root[currentKey] as unknown[]) : [];
      list.push(parseScalarOrInlineArray(item[1] ?? ''));
      root[currentKey] = list;
      continue;
    }
    throw new Error(`Unsupported skill YAML line: ${rawLine}`);
  }
  flushBlock();
  return root;
}

function parseScalarOrInlineArray(value: string): unknown {
  const trimmed = unquote(value.trim());
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => unquote(item.trim())) : [];
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      quote = quote === character ? undefined : quote ?? character;
    }
    if (character === '#' && !quote) return line.slice(0, index).trimEnd();
  }
  return line;
}

function requiredName(value: unknown): string {
  const name = requiredString(value, 'name');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error('Skill name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens.');
  }
  return name;
}

function requiredString(value: unknown, key: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`Skill "${key}" is required.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Skill "${key}" must be a list.`);
  return value.map((item) => requiredString(item, key));
}

function normalizeDefaults(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Skill "defaults" must be an object.');
  }
  const output: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      output[key] = entry;
    }
  }
  return output;
}

function normalizeOutputFormat(value: unknown): SkillDefinition['outputFormat'] {
  if (value === undefined) return 'markdown';
  if (value === 'markdown' || value === 'json' || value === 'text') return value;
  throw new Error('Skill output_format must be markdown, json, or text.');
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
