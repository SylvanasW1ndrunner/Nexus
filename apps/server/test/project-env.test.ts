import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectEnvError, loadProjectEnv } from '../src/project-env.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project .env loading', () => {
  it('continues when the Project has no .env file', async () => {
    const directory = await temporaryDirectory();
    const target: NodeJS.ProcessEnv = {};

    await expect(loadProjectEnv(directory, target)).resolves.toEqual({
      loaded: false,
      path: join(directory, '.env'),
      keys: [],
    });
    expect(target).toEqual({});
  });

  it('loads the documented SchemaNaut keys and basic quoted values', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, '.env'),
      [
        '# local Project configuration',
        'SCHEMANAUT_LLM_BASE_URL=https://api.example.test/v1',
        'SCHEMANAUT_LLM_API_KEY="sk-local-secret"',
        "SCHEMANAUT_LLM_MODEL='Qwen/Test Model'",
        'export SCHEMANAUT_DATABASE_URL=postgresql://user:pass@127.0.0.1/demo',
        '',
      ].join('\n'),
      'utf8',
    );
    const target: NodeJS.ProcessEnv = {};

    const result = await loadProjectEnv(directory, target);

    expect(result).toEqual({
      loaded: true,
      path: join(directory, '.env'),
      keys: [
        'SCHEMANAUT_LLM_BASE_URL',
        'SCHEMANAUT_LLM_API_KEY',
        'SCHEMANAUT_LLM_MODEL',
        'SCHEMANAUT_DATABASE_URL',
      ],
    });
    expect(target).toEqual({
      SCHEMANAUT_LLM_BASE_URL: 'https://api.example.test/v1',
      SCHEMANAUT_LLM_API_KEY: 'sk-local-secret',
      SCHEMANAUT_LLM_MODEL: 'Qwen/Test Model',
      SCHEMANAUT_DATABASE_URL: 'postgresql://user:pass@127.0.0.1/demo',
    });
  });

  it('does not overwrite values already supplied by the process environment', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, '.env'),
      'SCHEMANAUT_LLM_MODEL=file-model\nSCHEMANAUT_MAX_SCHEMA_TABLES=250\n',
      'utf8',
    );
    const target: NodeJS.ProcessEnv = {
      SCHEMANAUT_LLM_MODEL: 'process-model',
    };

    await loadProjectEnv(directory, target);

    expect(target.SCHEMANAUT_LLM_MODEL).toBe('process-model');
    expect(target.SCHEMANAUT_MAX_SCHEMA_TABLES).toBe('250');
  });

  it('rejects malformed entries without including their secret values in the error', async () => {
    const directory = await temporaryDirectory();
    const secret = 'sk-do-not-leak-this-value';
    await writeFile(
      join(directory, '.env'),
      `SCHEMANAUT_LLM_API_KEY="${secret}\n`,
      'utf8',
    );

    const promise = loadProjectEnv(directory, {});
    await expect(promise).rejects.toBeInstanceOf(ProjectEnvError);
    await expect(promise).rejects.toThrow('line 1');
    await expect(promise).rejects.not.toThrow(secret);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-env-'));
  temporaryDirectories.push(directory);
  return directory;
}
