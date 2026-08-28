// Mémoire des objets Todoist croisés pendant la session : elle permet de traduire
// un id opaque (« a1B2c3D4e5F6g7H8 ») en nom lisible dans les demandes de validation.

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
          recurring: node.recurring === true || node.due?.isRecurring === true,
          priority: node.priority,
          labels: Array.isArray(node.labels) ? node.labels : undefined,
          duration: durationLabel(node),
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

function durationLabel(task) {
  const d = task?.duration
  if (!d) return null
  if (typeof d === 'string') return d
  if (typeof d === 'object' && d.amount) {
    return d.unit === 'day' ? `${d.amount} j` : `${d.amount} min`
  }
  return null
}
