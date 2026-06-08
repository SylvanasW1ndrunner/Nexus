import electron from 'electron';
import type { IpcChannel, IpcRequestMap, IpcResponseMap } from '@dbagent/shared';

const { contextBridge, ipcRenderer } = electron;

const api = {
  invoke<Channel extends IpcChannel>(
    channel: Channel,
    request: IpcRequestMap[Channel],
  ): Promise<IpcResponseMap[Channel]> {
    return ipcRenderer.invoke(channel, request);
  },
  onMenuCommand(listener: (command: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on('app:menu-command', handler);
    return () => ipcRenderer.off('app:menu-command', handler);
  },
};

contextBridge.exposeInMainWorld('dbagent', api);

export type DbagentDesktopApi = typeof api;
