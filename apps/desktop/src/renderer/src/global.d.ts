import type { DbagentDesktopApi } from '../../preload/preload.js';

declare global {
  interface Window {
    dbagent: DbagentDesktopApi;
  }
}
