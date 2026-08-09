import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as legacyModule from '../src/legacy-model-compatibility.js';
import { OpenAIChatCodec } from '../src/protocol/codecs/openai-chat.js';
import type {
  ModelClient,
  ModelProtocolCodec,
  ModelRouteSnapshotInput,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('Task 2 round-three codec and package security', () => {
  it('does not expose a mutable codec registry or named codec singleton at package root', () => {
    expect('MODEL_PROTOCOL_CODEC_REGISTRY' in core).toBe(false);
    expect('openAIChatCodec' in core).toBe(false);
  });

  it('returns only a frozen exact singleton with a frozen prototype', () => {
    const first = core.resolveModelProtocolCodec('openai-chat', 'openai-chat@1');
    const second = core.resolveModelProtocolCodec('openai-chat', 'openai-chat@1');
    const prototype = Object.getPrototypeOf(first) as Record<PropertyKey, unknown>;
    const originalRevision = first.revision;
    const originalEncode = prototype.encode;

    const revisionChanged = Reflect.set(first, 'revision', 'forged@1');
    const encodeChanged = Reflect.set(prototype, 'encode', () => ({
      wireRequest: {}, correlations: [], opaqueBlockRefs: [],
    }));
    if (revisionChanged) Reflect.set(first, 'revision', originalRevision);
    if (encodeChanged) Reflect.set(prototype, 'encode', originalEncode);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(revisionChanged).toBe(false);
    expect(encodeChanged).toBe(false);
  });

  it('rejects a separately constructed official codec instance', () => {
    expect(() => core.createModelSession({
      route: route(),
      generation: {},
      codec: new OpenAIChatCodec(),
      client: staticClient(),
    })).toThrow(/exact.*singleton|registered.*singleton/i);
  });

  it('does not export the legacy codec constructor and rejects subclass-created instances', () => {
    type LegacyConstructor = new () => ModelProtocolCodec;
    const constructor = Reflect.get(legacyModule, 'LegacyProviderCodec') as
      | LegacyConstructor
      | undefined;
    let subclassAccepted = false;
    if (constructor !== undefined) {
      class ForgedLegacyCodec extends constructor {}
      try {
        core.createModelSession({
          route: route({ protocol: 'legacy-normalized', codecRevision: 'legacy-normalized@1' }),
          generation: {},
          codec: new ForgedLegacyCodec(),
          client: staticClient(),
        });
        subclassAccepted = true;
      } catch {
        // Expected after the exact-singleton boundary is implemented.
      }
    }

    expect(constructor).toBeUndefined();
    expect(subclassAccepted).toBe(false);
  });

  it('publishes only the package root and blocks codec-authenticity deep imports', async () => {
    const packageJson = JSON.parse(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { exports?: unknown };
    expect(packageJson.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
    });

    const directory = await mkdtemp(join(tmpdir(), 'core-llm-exports-'));
    temporaryDirectories.push(directory);
    const packageDirectory = join(directory, 'node_modules', '@dbagent', 'core-llm');
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
    await mkdir(join(packageDirectory, 'protocol'), { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: '@dbagent/core-llm',
      type: 'module',
      exports: packageJson.exports,
    }));
    await writeFile(join(packageDirectory, 'dist', 'index.js'), 'export const root = true;');
    await writeFile(join(packageDirectory, 'protocol', 'codec-authenticity.js'), 'export const forge = true;');
    const resolve = createRequire(join(directory, 'consumer.cjs')).resolve;

    expect(resolve('@dbagent/core-llm')).toBe(join(packageDirectory, 'dist', 'index.js'));
    expectErrorCode(
      () => resolve('@dbagent/core-llm/protocol/codec-authenticity.js'),
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  });
});

function expectErrorCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error & { readonly code?: unknown }).code).toBe(code);
}

function route(overrides: Partial<ModelRouteSnapshotInput> = {}): ModelRouteSnapshotInput {
  return {
    routeId: 'route-1',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { chat: 'supported' },
    generationParameters: {},
    contextTokens: 8_192,
    maxInputTokens: 4_096,
    maxOutputTokens: 1_024,
    metadata: { source: 'fixture', revision: 'route-v1', digest: 'computed' },
    ...overrides,
  };
}

function staticClient(): ModelClient {
  return {
    execute: () => Promise.resolve({
      kind: 'json',
      response: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
    }),
  };
}
