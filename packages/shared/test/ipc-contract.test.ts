import { describe, expect, it } from 'vitest';
import { ipcChannels, type IpcRequestMap, type IpcResponseMap } from '../src/ipc.js';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

const requestAndResponseMapsUseSameKeys: Equal<keyof IpcRequestMap, keyof IpcResponseMap> = true;

describe('ipc contract', () => {
  it('keeps request and response maps aligned at compile time', () => {
    expect(requestAndResponseMapsUseSameKeys).toBe(true);
  });

  it('exposes the expected BetaV0.1.1 channel set without duplicates', () => {
    const channels = flattenChannels(ipcChannels);

    expect(channels).toEqual([
      'connection:list',
      'connection:test',
      'connection:create',
      'connection:update',
      'connection:remove',
      'connection:connect',
      'connection:disconnect',
      'db:execute-query',
      'db:cancel-query',
      'db:query-history',
      'db:explain-query',
      'db:list-tables',
      'db:describe-table',
      'app:load-workspace-state',
      'app:save-workspace-state',
      'app:load-ide-settings',
      'app:save-ide-settings',
      'workspace:choose-directory',
      'workspace:create',
      'workspace:open',
      'workspace:list-recent',
      'workspace:load-active',
      'workspace:list-files',
      'workspace:read-file',
      'workspace:write-file',
      'workspace:create-directory',
      'workspace:rename-file',
      'workspace:delete-file',
      'workspace:delete-directory',
      'workspace:save-sql-file',
      'workspace:update-settings',
      'auth:login',
      'auth:register',
      'auth:request-code',
      'auth:verify-code-login',
      'auth:reset-password',
      'auth:logout',
      'auth:status',
      'python:detect',
      'python:choose-path',
      'python:create-environment',
      'python:run-script',
      'terminal:create',
      'terminal:close',
      'terminal:clear',
      'terminal:resize',
      'terminal:write',
      'terminal:read',
      'terminal:run',
      'terminal:list',
      'plugin:list',
      'plugin:install',
      'plugin:uninstall',
      'plugin:enable',
      'plugin:disable',
      'usage:current-quota',
      'usage:history',
    ]);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

function flattenChannels(channelGroups: Record<string, Record<string, string>>): string[] {
  return Object.values(channelGroups).flatMap((group) => Object.values(group));
}
