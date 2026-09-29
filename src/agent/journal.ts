// Journal des actions d'un tour : ce qui a été fait, et comment le défaire.
//
// Rien n'est soumis à validation avant exécution — l'agent agit, puis l'app rend
// compte. Pour que « Annuler » soit autre chose qu'un vœu, on capture l'état d'avant
// *au moment de l'appel* (la mémoire des tâches n'est mise à jour qu'au retour de
// l'outil) et on en déduit l'appel inverse.

import type { ActionState, Impact, Recap, SummaryLine } from '../shared/types.ts'
import { describeAction } from './summary.ts'
import { buildImpact } from './impact.ts'
import { arr, asRecord, type Loose, type TaskInput, type ToolInput } from './json.ts'
import type { TaskRegistry } from './registry.ts'

/** Un appel d'outil à rejouer pour défaire une action. */
export interface UndoCall {
  tool: string
  input: Loose
}

/**
 * Comment défaire une action : les appels inverses, ou — pour une création — l'attente
 * des ids que Todoist va attribuer. `note` dit ce qui ne se rattrape pas.
 */
interface Undo {
  calls?: UndoCall[]
  pending?: 'created'
  contents?: string[]
  note?: string | null
}

interface JournalEntry {
  toolName: string
  input: ToolInput
  title: string
  lines: SummaryLine[]
  mono: boolean
  impact: Impact | null
  undo: Undo | null
  state: ActionState
}

/** Outils Todoist qui écrivent. Le reste ne laisse aucune trace à raconter. */
const TODOIST_WRITE = /^mcp__todoist__(add|update|complete|uncomplete|delete|reschedule|move|reorder|manage|import|project-)/
/** Écritures locales : elles comptent dans le récap, mais aucune ne se rattrape. */
const LOCAL_WRITE = new Set(['Bash', 'Write', 'Edit'])

export class ActionJournal {
  registry: TaskRegistry
  /** Appels partis, dont le résultat n'est pas encore revenu. */
  open = new Map<string, JournalEntry>()
  /** Actions du tour en cours. */
  turn: JournalEntry[] = []
  /** Récaps déjà rendus, pour que « Annuler » marche encore trois messages plus tard. */
  recaps = new Map<string, JournalEntry[]>()
  seq = 0

  constructor(registry: TaskRegistry) {
    this.registry = registry
  }

  /** Un redémarrage de session perd les appels en vol ; les récaps, eux, restent valables. */
  reset(): void {
    this.open.clear()
    this.turn = []
  }

  /** Appelé quand l'agent lance un outil : c'est le dernier instant où l'état d'avant est intact. */
  noteCall(toolUseId: string, toolName: string, input: ToolInput): void {
    if (!TODOIST_WRITE.test(toolName) && !LOCAL_WRITE.has(toolName)) return
    const described = describeAction(toolName, input, this.registry)
    if (!described) return

    const undo = LOCAL_WRITE.has(toolName) ? null : inverseOf(toolName, input, this.registry)
    const entry: JournalEntry = {
      toolName,
      input,
      title: described.title,
      lines: described.lines,
      mono: described.mono === true,
      impact: buildImpact(toolName, input, this.registry),
      undo,
      state: 'pending',
    }
    this.open.set(toolUseId, entry)
    this.turn.push(entry)
  }

  /** Appelé au retour de l'outil : on sait enfin si l'action a pris, et sous quels ids. */
  noteResult(toolUseId: string, ok: boolean, rawText: string): void {
    const entry = this.open.get(toolUseId)
    if (!entry) return
    this.open.delete(toolUseId)
    entry.state = ok ? 'done' : 'failed'
    if (!ok) { entry.undo = null; return }

    // Une création ne s'annule qu'une fois connus les ids que Todoist vient d'attribuer.
    if (entry.undo?.pending === 'created') {
      const ids = createdIds(rawText, entry.undo.contents)
      entry.undo = ids.length
        ? { calls: ids.map((id) => ({ tool: 'mcp__todoist__delete-object', input: { type: 'task', id } })) }
        : null
    }
  }

  /** Clôt le tour et prépare le récap. */
  closeTurn(undoTurn: boolean): Recap | null {
    const items = this.turn
    this.turn = []
    // Un appel resté sans réponse (interruption) : on ne sait pas s'il a abouti.
    for (const entry of this.open.values()) entry.state = 'unknown'
    for (const entry of items) if (entry.state === 'unknown') entry.undo = null
    this.open.clear()
    if (!items.length) return null

    const id = `recap-${++this.seq}`
    this.recaps.set(id, items)
    // Au-delà de quelques récaps, l'état d'avant n'est plus fiable : on oublie les vieux.
    for (const old of [...this.recaps.keys()].slice(0, -8)) this.recaps.delete(old)

    return {
      id,
      undoTurn: Boolean(undoTurn),
      undoable: items.filter((e) => e.undo?.calls?.length).length,
      items: items.map((e) => ({
        title: e.title,
        lines: e.lines,
        mono: e.mono,
        impact: e.impact,
        state: e.state,
        undoable: Boolean(e.undo?.calls?.length),
        note: e.undo?.note || (e.state === 'done' && !e.undo?.calls?.length ? nonUndoableReason(e.toolName) : null),
      })),
    }
  }

  /**
   * Consigne d'annulation : la liste exacte des appels inverses, dans l'ordre inverse
   * des actions. L'agent n'a rien à décider — juste à exécuter.
   */
  undoMessage(recapId: string): string | null {
    const items = this.recaps.get(recapId)
    if (!items) return null

    const calls: UndoCall[] = []
    const lost: string[] = []
    for (const entry of [...items].reverse()) {
      if (entry.undo?.calls?.length) calls.push(...entry.undo.calls)
      else if (entry.state === 'done') lost.push(entry.title)
    }
    if (!calls.length && !lost.length) return null

    const steps = calls.map((c, i) => `${i + 1}. \`${c.tool}\`\n   ${JSON.stringify(c.input)}`)
    const parts = [
      '⟲ ANNULATION — l’utilisateur vient de cliquer sur « Annuler » dans l\'app.',
      '',
    ]
    if (steps.length) {
      parts.push(
        'Exécute **exactement** ces appels d\'outil, dans cet ordre, sans rien y ajouter,',
        'sans rien relire avant, et sans poser la moindre question :',
        '',
        ...steps,
        '',
      )
    }
    if (lost.length) {
      parts.push(
        `Ces actions-là ne se rattrapent pas, ne tente rien pour elles : ${lost.join(' ; ')}.`,
        '',
      )
    }
    parts.push('Puis réponds en une seule ligne, commençant par « ⟲ Annulé : », qui dit ce qui est revenu en arrière. Rien d\'autre.')
    return parts.join('\n')
  }
}

// ------------------------------------------------------------------ inverses

/** L'appel qui défait l'appel donné, calculé sur l'état d'avant. */
function inverseOf(toolName: string, input: ToolInput, registry: TaskRegistry | null): Undo | null {
  switch (toolName) {
    case 'mcp__todoist__add-tasks': {
      const contents = arr<TaskInput>(input.tasks).map((t) => t.content).filter((c): c is string => Boolean(c))
      return contents.length ? { pending: 'created', contents } : null
    }

    case 'mcp__todoist__complete-tasks': {
      const ids = arr<string>(input.ids)
      return ids.length ? { calls: [{ tool: 'mcp__todoist__uncomplete-tasks', input: { ids } }] } : null
    }

    case 'mcp__todoist__uncomplete-tasks': {
      const ids = arr<string>(input.ids)
      return ids.length ? { calls: [{ tool: 'mcp__todoist__complete-tasks', input: { ids } }] } : null
    }

    case 'mcp__todoist__reschedule-tasks': {
      const tasks: Array<{ id: unknown, date: string }> = []
      let partial = false
      for (const t of arr<TaskInput>(input.tasks)) {
        const before = registry?.task(t.id)
        if (before?.due) tasks.push({ id: t.id, date: before.due })
        else partial = true
      }
      if (!tasks.length) return { note: 'sa date d\'origine n\'était pas connue' }
      return {
        calls: [{ tool: 'mcp__todoist__reschedule-tasks', input: { tasks } }],
        note: partial ? 'annulation partielle : une date d\'origine manquait' : null,
      }
    }

    case 'mcp__todoist__update-tasks':
      return inverseUpdate(input, registry)

    case 'mcp__todoist__delete-object': {
      if (input.type && input.type !== 'task') return { note: 'une suppression de conteneur ne se rattrape pas' }
      const before = registry?.task(input.id)
      if (!before?.content) return { note: 'la tâche supprimée n\'était pas connue' }
      return {
        calls: [{
          tool: 'mcp__todoist__add-tasks',
          input: { tasks: [clean({
            content: before.content,
            dueString: before.dueString || before.due || undefined,
            priority: before.priority,
            duration: before.durationInput,
            labels: before.labels,
            projectId: before.projectId,
          })] },
        }],
        note: 'recréée à l\'identique, avec un nouvel identifiant',
      }
    }

    case 'mcp__todoist__project-move': {
      const before = registry?.task(input.id)?.projectId
      if (!before) return { note: 'son projet d\'origine n\'était pas connu' }
      return { calls: [{ tool: 'mcp__todoist__project-move', input: { id: input.id, projectId: before } }] }
    }

    default:
      // Réordonner, gérer des assignations, importer : trop peu structuré pour être défait.
      return null
  }
}

/** Rétablit champ par champ ce qu'un `update-tasks` a écrasé. */
function inverseUpdate(input: ToolInput, registry: TaskRegistry | null): Undo {
  const metadata: Loose[] = []
  const reschedules: Array<{ id: unknown, date: string }> = []
  let partial = false

  for (const task of arr<TaskInput>(input.tasks)) {
    const before = registry?.task(task.id)
    if (!before) { partial = true; continue }
    const restore: Loose = { id: task.id }

    if (task.content != null) restore.content = before.content
    if (task.priority != null) restore.priority = before.priority
    if (task.labels != null) restore.labels = before.labels || []
    if (task.duration != null) restore.duration = before.durationInput
    if (task.description != null) partial = true // le texte d'avant n'est pas mémorisé
    if (task.projectId != null) restore.projectId = before.projectId
    if (task.sectionId != null) restore.sectionId = before.sectionId
    if (task.deadlineDate != null) partial = true // la date limite d'avant n'est pas mémorisée

    const touchesDue = Object.keys(task).some((k) => /^due/i.test(k))
    if (touchesDue) {
      // Une récurrence ne se rétablit que par sa formulation ; une date simple se
      // repose proprement avec `reschedule-tasks`.
      if (before.recurring && before.dueString) restore.dueString = before.dueString
      else if (before.due) reschedules.push({ id: task.id, date: before.due })
      else if (before.dueString) restore.dueString = before.dueString
      else partial = true
    }

    const cleaned = clean(restore)
    if (Object.keys(cleaned).length > 1) metadata.push(cleaned)
  }

  const calls: UndoCall[] = []
  if (metadata.length) calls.push({ tool: 'mcp__todoist__update-tasks', input: { tasks: metadata } })
  if (reschedules.length) calls.push({ tool: 'mcp__todoist__reschedule-tasks', input: { tasks: reschedules } })
  if (!calls.length) return { note: 'l\'état d\'avant n\'était pas connu' }
  return { calls, note: partial ? 'annulation partielle : une valeur d\'avant manquait' : null }
}

function nonUndoableReason(toolName: string): string {
  if (LOCAL_WRITE.has(toolName)) return 'hors Todoist : non annulable'
  return 'non annulable'
}

// ------------------------------------------------------------------ helpers

/** Retrouve les ids que Todoist vient d'attribuer, en recoupant par le titre. */
function createdIds(rawText: string, contents: string[] | undefined): string[] {
  let data: unknown
  try {
    data = JSON.parse(String(rawText))
  } catch {
    return []
  }
  const found: Array<{ id: string, content: string }> = []
  walk(data, 0, (node) => {
    if (typeof node.id === 'string' && typeof node.content === 'string') found.push({ id: node.id, content: node.content })
  })
  const ids: string[] = []
  for (const content of contents || []) {
    const hit = found.find((o) => o.content === content && !ids.includes(o.id))
    if (hit) ids.push(hit.id)
  }
  // Le titre a pu être normalisé par Todoist : à défaut, on se fie au compte.
  if (!ids.length && found.length && found.length === (contents || []).length) return found.map((o) => o.id)
  return ids
}

function walk(node: unknown, depth: number, visit: (node: Loose) => void): void {
  if (depth > 6 || !node) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, visit)
    return
  }
  const record = asRecord(node)
  if (!record) return
  visit(record)
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') walk(value, depth + 1, visit)
  }
}

function clean(obj: Loose): Loose {
  const out: Loose = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v
  return out
}
