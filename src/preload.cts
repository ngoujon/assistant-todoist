// Pont contextIsolation : la page ne voit que ces fonctions, jamais Node ni l'IPC brut.
// Chargé en CommonJS — c'est ce qu'exige un preload en bac à sable.
import type { IpcRendererEvent } from 'electron'
import type { AgentEvent, AssistantApi } from './shared/types.ts'

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const api: AssistantApi = {
  init: () => ipcRenderer.invoke('app:init'),
  send: (text) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  newChat: () => ipcRenderer.send('chat:new'),
  setConfig: (patch) => ipcRenderer.send('chat:config', patch),
  undo: (recapId) => ipcRenderer.invoke('chat:undo', recapId),
  openWorkspace: () => ipcRenderer.send('app:open-workspace'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  onEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, evt: AgentEvent) => cb(evt)
    ipcRenderer.on('agent', handler)
    return () => { ipcRenderer.removeListener('agent', handler) }
  },
}

contextBridge.exposeInMainWorld('assistant', api)
