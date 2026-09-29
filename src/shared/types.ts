// Types partagés entre le processus principal, le preload et l'interface : tout ce qui
// traverse l'IPC. Uniquement des types — rien de ce fichier n'existe à l'exécution.

// ------------------------------------------------------------------ impact

export type ImpactKind = 'stay' | 'leaving' | 'moved'

export interface ImpactBlock {
  id: string
  name: string
  /** Minutes depuis minuit ; null pour une tâche « journée ». */
  start: number | null
  end: number | null
  allDay: boolean
  kind: ImpactKind
}

export interface ImpactDay {
  day: string
  label: string
  from: number
  to: number
  before: ImpactBlock[]
  after: ImpactBlock[]
}

export interface ImpactConflict {
  day: string
  moved: string
  against: string
}

export interface Impact {
  days: ImpactDay[]
  conflicts: ImpactConflict[]
}

// ------------------------------------------------------------------- recap

export interface SummaryLine {
  head: string
  meta?: string
}

export type ActionState = 'pending' | 'done' | 'failed' | 'unknown'

export interface RecapItem {
  title: string
  lines: SummaryLine[]
  mono: boolean
  impact: Impact | null
  state: ActionState
  undoable: boolean
  note: string | null
}

export interface Recap {
  id: string
  undoTurn: boolean
  undoable: number
  items: RecapItem[]
}

// ------------------------------------------------------------- évènements

export type AgentStatus = 'connecting' | 'thinking' | 'idle'

export type AgentEvent =
  | { k: 'status', state: AgentStatus }
  | { k: 'ready', sessionId: string, model: string, todoist: string }
  | { k: 'resumed' }
  | { k: 'cleared' }
  | { k: 'turn-start' }
  | { k: 'interrupted' }
  | { k: 'text-start' }
  | { k: 'text-delta', text: string }
  | { k: 'thinking-start' }
  | { k: 'thinking-delta', text: string }
  | { k: 'tool-use', id: string, name: string, input: unknown }
  | { k: 'tool-result', id: string, name: string, ok: boolean, preview: string }
  | ({ k: 'recap' } & Recap)
  | { k: 'result', isError: boolean, text: string, costUsd?: number, durationMs?: number }
  | { k: 'note', text: string }
  | { k: 'error', message: string }

// -------------------------------------------------------------------- pont

export interface ConfigPatch {
  model?: string
}

export interface InitState {
  config: { model: string }
  workspace: string
  version: string
}

/** Ce que `preload.cts` expose à la page sous `window.assistant`. */
export interface AssistantApi {
  init(): Promise<InitState>
  send(text: string): void
  interrupt(): void
  newChat(): void
  setConfig(patch: ConfigPatch): void
  undo(recapId: string): Promise<boolean>
  openWorkspace(): void
  openExternal(url: string): void
  onEvent(cb: (evt: AgentEvent) => void): () => void
}
