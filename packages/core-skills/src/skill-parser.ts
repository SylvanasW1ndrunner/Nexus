import { parseDocument } from 'yaml';
import { createHash } from 'node:crypto';
import type {
  SkillDescriptor,
  SkillDocument,
  SkillFrontmatter,
  SkillScope,
} from './types.js';

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMPATIBILITY_LENGTH = 500;
const NAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/;
const STANDARD_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

export type SkillParseContext = {
  scope: SkillScope;
  sourceId: string;
  sourcePath: string;
  bundleRoot: string;
  sourceOrder: number;
  expectedName?: string;
  modifiedAtMs?: number;
  /** Complete normalized document digest supplied by the registry. */
  contentDigest?: string;
  revisionRef?: SkillDescriptor['revisionRef'];
};

export type ExtractedSkillParts = {
  frontmatter: string;
  body: string;
};

export function parseSkillMetadata(content: string, context: SkillParseContext): SkillDescriptor {
  const { frontmatter } = extractSkillParts(content, false);
  return toDescriptor(
    parseFrontmatter(frontmatter),
    context,
    checkedContentDigest(content, context),
    Buffer.byteLength(content, 'utf8'),
  );
}

export function parseSkillDocument(content: string, context: SkillParseContext): SkillDocument {
  const { frontmatter, body } = extractSkillParts(content, true);
  return {
    ...toDescriptor(
      parseFrontmatter(frontmatter),
      context,
      checkedContentDigest(content, context),
      Buffer.byteLength(content, 'utf8'),
    ),
    instructions: body.trim(),
  };
}

export function extractSkillParts(
  content: string,
  requireCompleteDocument = true,
): ExtractedSkillParts {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) {
    if (!normalized.startsWith('---\n')) {
      throw new Error('SKILL.md must start with YAML frontmatter delimited by "---".');
    }
    throw new Error('SKILL.md YAML frontmatter is missing its closing "---" delimiter.');
  }

  return {
    frontmatter: match[1] ?? '',
    body: requireCompleteDocument ? normalized.slice(match[0].length) : '',
  };
}

function parseFrontmatter(source: string): SkillFrontmatter {
  const document = parseDocument(source, {
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    prettyErrors: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Invalid SKILL.md YAML frontmatter: ${document.errors[0]!.message}`);
  }

  const parsed: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(parsed)) {
    throw new Error('SKILL.md YAML frontmatter must be a mapping.');
  }

  const name = requiredString(parsed.name, 'name');
  validateName(name);
  const description = requiredString(parsed.description, 'description');
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Skill "description" must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`);
  }

  const license = optionalString(parsed.license, 'license');
  const compatibility = optionalString(parsed.compatibility, 'compatibility');
  if (compatibility && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    throw new Error(
      `Skill "compatibility" must not exceed ${MAX_COMPATIBILITY_LENGTH} characters.`,
    );
  }

  const metadata = parseMetadata(parsed.metadata);
  const allowedTools = parseAllowedTools(
    parsed['allowed-tools'],
    Object.prototype.hasOwnProperty.call(parsed, 'allowed-tools'),
  );
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!STANDARD_FIELDS.has(key)) extensions[key] = value;
  }

  return {
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata: Object.freeze(metadata),
    ...(allowedTools === undefined ? {} : { allowedTools: Object.freeze(allowedTools) }),
    extensions: Object.freeze(extensions),
  };
}

function toDescriptor(
  frontmatter: SkillFrontmatter,
  context: SkillParseContext,
  digest: string,
  byteSize: number,
): SkillDescriptor {
  if (context.expectedName && frontmatter.name !== context.expectedName) {
    throw new Error(
      `Skill name "${frontmatter.name}" must match its parent directory "${context.expectedName}".`,
    );
  }
  const revisionRef = Object.freeze(
    context.revisionRef === undefined
      ? singleFileRevisionRef(frontmatter.name, context, digest, byteSize)
      : checkedRevisionRef(frontmatter.name, context, digest),
  );
  return {
    ...frontmatter,
    scope: context.scope,
    sourceId: context.sourceId,
    sourcePath: context.sourcePath,
    bundleRoot: context.bundleRoot,
    sourceOrder: context.sourceOrder,
    ...(context.modifiedAtMs === undefined ? {} : { modifiedAtMs: context.modifiedAtMs }),
    contentDigest: digest,
    revisionRef,
  };
}

function validateName(name: string): void {
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Skill "name" must not exceed ${MAX_NAME_LENGTH} characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      'Skill "name" must use lowercase letters, numbers, and single hyphens; it cannot start or end with a hyphen.',
    );
  }
}

function parseMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error('Skill "metadata" must be a mapping of string keys to string values.');
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`Skill "metadata.${key}" must be a string.`);
    }
    output[key] = entry;
  }
  return output;
}

function parseAllowedTools(value: unknown, present: boolean): string[] | undefined {
  if (!present) return undefined;
  if (value === undefined || value === null) return [];
  if (value === '') return [];
  if (typeof value !== 'string') {
    throw new Error(
      'Skill "allowed-tools" must be a space-separated string as defined by Agent Skills.',
    );
  }

  const output: string[] = [];
  let token = '';
  let parenthesisDepth = 0;
  for (const character of value.trim()) {
    if (/\s/.test(character) && parenthesisDepth === 0) {
      if (token) output.push(token);
      token = '';
      continue;
    }
    if (character === '(') parenthesisDepth += 1;
    if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) {
        throw new Error('Skill "allowed-tools" contains unbalanced parentheses.');
      }
    }
    token += character;
  }
  if (parenthesisDepth !== 0) {
    throw new Error('Skill "allowed-tools" contains unbalanced parentheses.');
  }
  if (token) output.push(token);
  return [...new Set(output)];
}

function checkedContentDigest(content: string, context: SkillParseContext): string {
  const digest = digestDocument(content);
  if (context.contentDigest !== undefined && context.contentDigest !== digest) {
    throw new Error('SKILL.md content digest does not match the captured revision.');
  }
  return digest;
}

function digestDocument(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function singleFileRevisionRef(
  name: string,
  context: SkillParseContext,
  contentDigest: string,
  byteSize: number,
): SkillDescriptor['revisionRef'] {
  const resource = [{ path: 'SKILL.md', contentDigest, byteSize }];
  const bundleDigest = digestDocument(canonicalJson(resource));
  const identity = {
    schemaVersion: 1 as const,
    scope: context.scope,
    sourceId: context.sourceId,
    sourcePath: context.sourcePath,
    bundleRoot: context.bundleRoot,
    sourceOrder: context.sourceOrder,
    name,
    contentDigest,
    bundleDigest,
  };
  return Object.freeze({
    ...identity,
    revisionId: digestDocument(canonicalJson(identity)),
  });
}

function checkedRevisionRef(
  name: string,
  context: SkillParseContext,
  contentDigest: string,
): SkillDescriptor['revisionRef'] {
  const revisionRef = context.revisionRef!;
  if (
    revisionRef.scope !== context.scope ||
    revisionRef.sourceId !== context.sourceId ||
    revisionRef.sourcePath !== context.sourcePath ||
    revisionRef.bundleRoot !== context.bundleRoot ||
    revisionRef.sourceOrder !== context.sourceOrder ||
    revisionRef.name !== name ||
    revisionRef.contentDigest !== contentDigest
  ) {
    throw new Error('Skill revision provenance does not match the parse context.');
  }
  const identity = {
    schemaVersion: revisionRef.schemaVersion,
    scope: revisionRef.scope,
    sourceId: revisionRef.sourceId,
    sourcePath: revisionRef.sourcePath,
    bundleRoot: revisionRef.bundleRoot,
    sourceOrder: revisionRef.sourceOrder,
    name: revisionRef.name,
    contentDigest: revisionRef.contentDigest,
    bundleDigest: revisionRef.bundleDigest,
  };
  if (digestDocument(canonicalJson(identity)) !== revisionRef.revisionId) {
    throw new Error('Skill revision identity does not match its provenance.');
  }
  return { ...revisionRef };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot canonicalize an undefined value.');
  return serialized;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (!result) throw new Error(`Skill "${field}" is required.`);
  return result;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Skill "${field}" must be a string.`);
  const result = value.trim();
  return result || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
