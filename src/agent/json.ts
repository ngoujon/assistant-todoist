// Les outils Todoist renvoient du JSON dont la forme varie d'un outil à l'autre :
// on le lit prudemment, champ par champ, plutôt que de lui faire confiance.

export type Loose = Record<string, unknown>

/** L'objet lui-même s'il en est un (tableaux exclus), sinon undefined. */
export function asRecord(value: unknown): Loose | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : undefined
}

/** Les éléments non vides d'un tableau ; tout le reste donne une liste vide. */
export function arr<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(Boolean) as T[]) : []
}

/**
 * Arguments d'un appel d'outil, tels que l'agent les envoie. Rien n'est garanti :
 * chaque champ se vérifie avant usage.
 */
export interface ToolInput {
  tasks?: unknown
  ids?: unknown
  id?: string
  type?: string
  projectId?: string
  name?: string
  command?: string
  file_path?: string
  [key: string]: unknown
}

/** Une tâche dans les arguments de `add-tasks`, `update-tasks` ou `reschedule-tasks`. */
export interface TaskInput {
  id?: string
  content?: string
  priority?: string
  labels?: unknown
  duration?: string
  dueString?: string
  deadlineDate?: string
  date?: string
  projectId?: string
  sectionId?: string
  parentId?: string
  description?: string
  responsibleUser?: string
  [key: string]: unknown
}

/** Arguments d'outil lus depuis une valeur quelconque (null, tableau… deviennent un objet vide). */
export function toolInput(value: unknown): ToolInput {
  return (asRecord(value) as ToolInput | undefined) ?? {}
}
