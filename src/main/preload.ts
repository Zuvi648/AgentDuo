// Preload: stellt dem Renderer ausschließlich die freigegebenen IPC-Kanäle bereit.
import { contextBridge, ipcRenderer } from 'electron';

// Kanalnamen sind hier dupliziert, weil das Preload-Skript in der Sandbox läuft.
const INVOKE = new Set([
  'settings:get', 'settings:set', 'env:check', 'env:install', 'env:login', 'env:test',
  'dialog:pickDir', 'dialog:pickFile', 'git:state',
  'task:list', 'task:log', 'task:create', 'task:approvePlan', 'task:pause', 'task:resume',
  'task:cancel', 'task:answer', 'task:delete', 'task:openTerminal', 'shell:reveal',
  'profile:list', 'profile:save', 'profile:delete', 'models:list', 'quota:get',
  'publish:state', 'publish:commit', 'publish:merge', 'publish:push', 'publish:open', 'publish:setRemote', 'pipeline:info',
]);
const EVENTS = new Set(['task:update', 'agent:event', 'setup:log', 'quota:update', 'profile:update']);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`IPC-Kanal nicht erlaubt: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) throw new Error(`Ereigniskanal nicht erlaubt: ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
