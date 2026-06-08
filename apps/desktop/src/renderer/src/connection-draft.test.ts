import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '@dbagent/shared';
import { connectionToDraft, defaultConnectionDraft } from './connection-draft.js';

describe('connection draft helpers', () => {
  it('creates a safe editable draft from a saved remote connection without restoring password', () => {
    const connection: SavedConnection = {
      id: 'conn-1',
      name: 'Production analytics',
      engine: 'postgres',
      host: 'analytics.example.com',
      port: 5432,
      database: 'warehouse',
      username: 'analyst',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 15000,
      statementTimeoutMs: 90000,
      status: 'connected',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };

    expect(connectionToDraft(connection)).toEqual({
      name: 'Production analytics',
      engine: 'postgres',
      host: 'analytics.example.com',
      port: 5432,
      database: 'warehouse',
      username: 'analyst',
      password: '',
      readOnly: true,
      ssl: true,
      connectionTimeoutMs: 15000,
      statementTimeoutMs: 90000,
    });
  });

  it('fills remote defaults for older saved connections', () => {
    expect(
      connectionToDraft({
        id: 'conn-2',
        name: 'Legacy local',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        database: 'postgres',
        username: 'postgres',
        readOnly: false,
        status: 'disconnected',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
      }),
    ).toMatchObject({
      password: '',
      ssl: false,
      connectionTimeoutMs: defaultConnectionDraft.connectionTimeoutMs,
      statementTimeoutMs: defaultConnectionDraft.statementTimeoutMs,
    });
  });
});
