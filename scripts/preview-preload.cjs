// Preload factice : sert uniquement à prévisualiser l'interface (scripts/preview.mjs).
const { contextBridge } = require('electron')

let listener = () => {}

contextBridge.exposeInMainWorld('assistant', {
  init: async () => ({
    config: { model: 'claude-opus-5', autoTodoist: true },
    workspace: '/tmp',
    version: '1.0.0',
  }),
  send: () => {},
  interrupt: () => {},
  newChat: () => {},
  setConfig: () => {},
  replyPermission: () => {},
  openWorkspace: () => {},
  openExternal: () => {},
  onEvent: (cb) => {
    listener = cb
    return () => {}
  },
  _fire: (evt) => listener(evt),
})
