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
};

contextBridge.exposeInMainWorld('dbagent', api);

export type DbagentDesktopApi = typeof api;
