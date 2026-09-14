const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assistant', {
  init: () => ipcRenderer.invoke('app:init'),
  send: (text) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  newChat: () => ipcRenderer.send('chat:new'),
  setConfig: (patch) => ipcRenderer.send('chat:config', patch),
  undo: (recapId) => ipcRenderer.invoke('chat:undo', recapId),
  openWorkspace: () => ipcRenderer.send('app:open-workspace'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  onEvent: (cb) => {
    const handler = (_e, evt) => cb(evt)
    ipcRenderer.on('agent', handler)
    return () => ipcRenderer.removeListener('agent', handler)
  },
})
