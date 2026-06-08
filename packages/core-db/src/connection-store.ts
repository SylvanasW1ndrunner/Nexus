import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectionInput, SavedConnection } from '@dbagent/shared';

export class ConnectionStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<SavedConnection[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as SavedConnection[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async create(input: ConnectionInput): Promise<SavedConnection> {
    const now = new Date().toISOString();
    const connection: SavedConnection = {
      id: randomUUID(),
      name: input.name.trim(),
      engine: input.engine,
      host: input.host.trim(),
      port: input.port,
      database: input.database.trim(),
      username: input.username.trim(),
      ssl: input.ssl ?? false,
      readOnly: input.readOnly ?? true,
      ...(input.connectionTimeoutMs !== undefined ? { connectionTimeoutMs: input.connectionTimeoutMs } : {}),
      ...(input.statementTimeoutMs !== undefined ? { statementTimeoutMs: input.statementTimeoutMs } : {}),
      status: 'disconnected',
      createdAt: now,
      updatedAt: now,
    };
    const connections = await this.list();
    await this.save([...connections, connection]);
    return connection;
  }

  async update(id: string, patch: Partial<ConnectionInput>): Promise<SavedConnection | undefined> {
    const connections = await this.list();
    const index = connections.findIndex((connection) => connection.id === id);
    if (index === -1) return undefined;
    const current = connections[index]!;
    const updated: SavedConnection = {
      ...current,
      name: patch.name?.trim() ?? current.name,
      host: patch.host?.trim() ?? current.host,
      port: patch.port ?? current.port,
      database: patch.database?.trim() ?? current.database,
      username: patch.username?.trim() ?? current.username,
      ssl: patch.ssl ?? current.ssl ?? false,
      readOnly: patch.readOnly ?? current.readOnly,
      ...(patch.connectionTimeoutMs ?? current.connectionTimeoutMs
        ? { connectionTimeoutMs: patch.connectionTimeoutMs ?? current.connectionTimeoutMs }
        : {}),
      ...(patch.statementTimeoutMs ?? current.statementTimeoutMs
        ? { statementTimeoutMs: patch.statementTimeoutMs ?? current.statementTimeoutMs }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    connections[index] = updated;
    await this.save(connections);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const connections = await this.list();
    const next = connections.filter((connection) => connection.id !== id);
    await this.save(next);
    return next.length !== connections.length;
  }

  async markStatus(id: string, status: SavedConnection['status']): Promise<SavedConnection | undefined> {
    const connections = await this.list();
    const index = connections.findIndex((connection) => connection.id === id);
    if (index === -1) return undefined;
    const updated: SavedConnection = { ...connections[index]!, status, updatedAt: new Date().toISOString() };
    connections[index] = updated;
    await this.save(connections);
    return updated;
  }

  private async save(connections: SavedConnection[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(connections, null, 2)}\n`, 'utf8');
  }
}
