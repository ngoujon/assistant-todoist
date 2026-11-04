// Preload factice : sert uniquement à prévisualiser l'interface (scripts/preview.ts).
import type { AgentEvent, AssistantApi } from '../src/shared/types.ts'

const { contextBridge } = require('electron') as typeof import('electron')

let listener: (evt: AgentEvent) => void = () => {}

const api: AssistantApi & { _fire(evt: AgentEvent): void } = {
  init: async () => ({
    config: { model: 'claude-opus-5-5' },
    workspace: '/tmp',
    version: '1.0.0',
  }),
  suggestions: async () => [
    { label: '➕ Ajouter une tâche', text: 'Ajoute une tâche ', send: false, count: 12 },
    { label: '↪️ Déplacer une tâche', text: 'Déplace la tâche ', send: false, count: 7 },
  ],
  send: () => {},
  interrupt: () => {},
  newChat: () => {},
  setConfig: () => {},
  undo: async () => true,
  openWorkspace: () => {},
  openExternal: () => {},
  onEvent: (cb) => {
    listener = cb
    return () => {}
  },
  _fire: (evt) => listener(evt),
}

contextBridge.exposeInMainWorld('assistant', api)
