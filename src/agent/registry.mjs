// Mémoire des objets Todoist croisés pendant la session : elle permet de traduire
// un id opaque (« a1B2c3D4e5F6g7H8 ») en nom lisible dans le récap, et surtout de
// retenir l'état d'avant — sans lui, aucune modification ne serait annulable.

const MAX_REMEMBERED = 600

export class TaskRegistry {
  constructor(snapshot) {
    this.tasks = new Map(snapshot?.tasks || [])
    this.named = new Map(snapshot?.named || []) // projets, sections, libellés : id -> nom
    this.dirty = false
  }

  /** Sérialisation pour survivre au redémarrage de l'app (conversation reprise). */
  snapshot() {
    return {
      tasks: [...this.tasks].slice(-MAX_REMEMBERED),
      named: [...this.named].slice(-MAX_REMEMBERED),
    }
  }

  /** Analyse le résultat brut d'un outil Todoist et mémorise ce qu'il contient. */
  note(rawText) {
    if (!rawText || !rawText.includes('"id"')) return
    let data
    try {
      data = JSON.parse(rawText)
    } catch {
      return
    }
    const before = this.tasks.size + this.named.size
    this.#walk(data, 0)
    if (this.tasks.size + this.named.size !== before) this.dirty = true
  }

  task(id) {
    return this.tasks.get(String(id))
  }

  /** Nom d'une tâche, ou un repli discret si elle n'a jamais été vue. */
  taskName(id) {
    return this.tasks.get(String(id))?.content || null
  }

  name(id) {
    return this.named.get(String(id)) || null
  }

  #walk(node, depth) {
    if (depth > 6 || !node) return
    if (Array.isArray(node)) {
      for (const item of node) this.#walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return

    const id = typeof node.id === 'string' ? node.id : null
    if (id) {
      if (typeof node.content === 'string') {
        this.tasks.set(id, {
          content: node.content,
          due: dueLabel(node),
          dueString: dueString(node),
          recurring: node.recurring === true || node.due?.isRecurring === true,
          priority: priorityFlag(node.priority),
          labels: Array.isArray(node.labels) ? node.labels : undefined,
          duration: durationLabel(node),
          durationInput: durationInput(node),
          projectId: node.projectId || node.project_id || undefined,
          sectionId: node.sectionId || node.section_id || undefined,
        })
      } else if (typeof node.name === 'string') {
        this.named.set(id, node.name)
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') this.#walk(value, depth + 1)
    }
  }
}

// L'API Todoist renvoie « dueDate » a plat ; d'autres formes existent selon l'outil.
function dueLabel(task) {
  if (typeof task?.dueDate === 'string') return task.dueDate
  const due = task?.due
  if (!due) return null
  if (typeof due === 'string') return due
  return due.date || due.string || null
}

/** Formulation d'origine de l'échéance (« tous les mardis à 10h ») : la seule qui rétablit une récurrence. */
function dueString(task) {
  const due = task?.due
  if (due && typeof due === 'object' && typeof due.string === 'string') return due.string
  if (typeof task?.dueString === 'string') return task.dueString
  return null
}

/** Même durée, au format attendu par `add-tasks` / `update-tasks` (« 45m », « 2d »). */
function durationInput(task) {
  const d = task?.duration
  if (!d) return undefined
  if (typeof d === 'string') return d
  if (typeof d === 'object' && d.amount) return d.unit === 'day' ? `${d.amount}d` : `${d.amount}m`
  return undefined
}

/**
 * Todoist renvoie la priorité en entier (4 = le plus fort) alors que ses outils
 * attendent un drapeau `p1`..`p4`. On range la forme utile à l'écriture.
 */
function priorityFlag(value) {
  if (value == null) return undefined
  const text = String(value).toLowerCase()
  if (/^p[1-4]$/.test(text)) return text
  const n = Number(text)
  return n >= 1 && n <= 4 ? `p${5 - n}` : undefined
}

function durationLabel(task) {
  const d = task?.duration
  if (!d) return null
  if (typeof d === 'string') return d
  if (typeof d === 'object' && d.amount) {
    return d.unit === 'day' ? `${d.amount} j` : `${d.amount} min`
  }
  return null
}
