// Mémoire des objets Todoist croisés pendant la session : elle permet de traduire
// un id opaque (« a1B2c3D4e5F6g7H8 ») en nom lisible dans le récap, et surtout de
// retenir l'état d'avant — sans lui, aucune modification ne serait annulable.

import { asRecord, type Loose } from './json.ts'

const MAX_REMEMBERED = 600

export type PriorityFlag = 'p1' | 'p2' | 'p3' | 'p4'

/** Ce qu'on retient d'une tâche : de quoi la nommer, et de quoi la rétablir. */
export interface KnownTask {
  content: string
  due: string | null
  dueString: string | null
  recurring: boolean
  priority: PriorityFlag | undefined
  labels: string[] | undefined
  duration: string | null
  durationInput: string | undefined
  projectId: string | undefined
  sectionId: string | undefined
}

export interface RegistrySnapshot {
  tasks: Array<[string, KnownTask]>
  named: Array<[string, string]>
}

export class TaskRegistry {
  tasks: Map<string, KnownTask>
  /** Projets, sections, libellés : id -> nom. */
  named: Map<string, string>
  dirty = false

  constructor(snapshot?: Partial<RegistrySnapshot> | null) {
    this.tasks = new Map(snapshot?.tasks || [])
    this.named = new Map(snapshot?.named || [])
  }

  /** Sérialisation pour survivre au redémarrage de l'app (conversation reprise). */
  snapshot(): RegistrySnapshot {
    return {
      tasks: [...this.tasks].slice(-MAX_REMEMBERED),
      named: [...this.named].slice(-MAX_REMEMBERED),
    }
  }

  /** Analyse le résultat brut d'un outil Todoist et mémorise ce qu'il contient. */
  note(rawText: string): void {
    if (!rawText || !rawText.includes('"id"')) return
    let data: unknown
    try {
      data = JSON.parse(rawText)
    } catch {
      return
    }
    const before = this.tasks.size + this.named.size
    this.#walk(data, 0)
    if (this.tasks.size + this.named.size !== before) this.dirty = true
  }

  task(id: unknown): KnownTask | undefined {
    return this.tasks.get(String(id))
  }

  /** Nom d'une tâche, ou un repli discret si elle n'a jamais été vue. */
  taskName(id: unknown): string | null {
    return this.tasks.get(String(id))?.content || null
  }

  name(id: unknown): string | null {
    return this.named.get(String(id)) || null
  }

  #walk(node: unknown, depth: number): void {
    if (depth > 6 || !node) return
    if (Array.isArray(node)) {
      for (const item of node) this.#walk(item, depth + 1)
      return
    }
    const record = asRecord(node)
    if (!record) return

    const id = typeof record.id === 'string' ? record.id : null
    if (id) {
      if (typeof record.content === 'string') {
        this.tasks.set(id, {
          content: record.content,
          due: dueLabel(record),
          dueString: dueString(record),
          recurring: record.recurring === true || asRecord(record.due)?.isRecurring === true,
          priority: priorityFlag(record.priority),
          labels: Array.isArray(record.labels) ? record.labels.map(String) : undefined,
          duration: durationLabel(record),
          durationInput: durationInput(record),
          projectId: stringOr(record.projectId) || stringOr(record.project_id) || undefined,
          sectionId: stringOr(record.sectionId) || stringOr(record.section_id) || undefined,
        })
      } else if (typeof record.name === 'string') {
        this.named.set(id, record.name)
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') this.#walk(value, depth + 1)
    }
  }
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// L'API Todoist renvoie « dueDate » a plat ; d'autres formes existent selon l'outil.
function dueLabel(task: Loose): string | null {
  if (typeof task.dueDate === 'string') return task.dueDate
  const due = task.due
  if (!due) return null
  if (typeof due === 'string') return due
  const record = asRecord(due)
  return stringOr(record?.date) || stringOr(record?.string) || null
}

/** Formulation d'origine de l'échéance (« tous les mardis à 10h ») : la seule qui rétablit une récurrence. */
function dueString(task: Loose): string | null {
  const due = asRecord(task.due)
  if (due && typeof due.string === 'string') return due.string
  if (typeof task.dueString === 'string') return task.dueString
  return null
}

/** Même durée, au format attendu par `add-tasks` / `update-tasks` (« 45m », « 2d »). */
function durationInput(task: Loose): string | undefined {
  const d = task.duration
  if (!d) return undefined
  if (typeof d === 'string') return d
  const record = asRecord(d)
  if (record?.amount) return record.unit === 'day' ? `${record.amount}d` : `${record.amount}m`
  return undefined
}

/**
 * Todoist renvoie la priorité en entier (4 = le plus fort) alors que ses outils
 * attendent un drapeau `p1`..`p4`. On range la forme utile à l'écriture.
 */
function priorityFlag(value: unknown): PriorityFlag | undefined {
  if (value == null) return undefined
  const text = String(value).toLowerCase()
  if (/^p[1-4]$/.test(text)) return text as PriorityFlag
  const n = Number(text)
  return n >= 1 && n <= 4 ? (`p${5 - n}` as PriorityFlag) : undefined
}

function durationLabel(task: Loose): string | null {
  const d = task.duration
  if (!d) return null
  if (typeof d === 'string') return d
  const record = asRecord(d)
  if (record?.amount) {
    return record.unit === 'day' ? `${record.amount} j` : `${record.amount} min`
  }
  return null
}
