// Traduit une action déjà exécutée en français lisible : le récap doit se lire sans
// JSON ni identifiants, et dire ce qui a changé — pas ce qu'on a demandé.

import type { SummaryLine } from '../shared/types.ts'
import { arr, type TaskInput, type ToolInput } from './json.ts'
import type { TaskRegistry } from './registry.ts'

export interface ActionSummary {
  title: string
  lines: SummaryLine[]
  mono?: boolean
}

const PRIORITY_LABEL: Record<string, string> = { p1: 'p1 — urgent', p2: 'p2 — important', p3: 'p3 — à faire', p4: 'p4 — un jour' }

const OBJECT_LABEL: Record<string, string> = {
  task: 'la tâche', project: 'le projet', section: 'la section', comment: 'le commentaire',
  label: 'le libellé', filter: 'le filtre', reminder: 'le rappel', location_reminder: 'le rappel de lieu',
}

/** « 2026-08-31T09:30:00 » -> « lundi 31 août à 9h30 ». */
export function frDate(value: unknown): string | null {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return value ? String(value) : null
  const [, y, mo, d, h, min] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(min || 0))
  const day = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  if (!h) return day
  return `${day} à ${Number(h)}h${min === '00' ? '' : min}`
}

const quote = (s: unknown) => `« ${String(s).trim()} »`
const plural = (n: number, one: string, many: string) => (n > 1 ? `${n} ${many}` : one)

/** null = l'action ne se raconte pas, elle n'a pas sa place dans le récap. */
export function describeAction(toolName: string, input: ToolInput, registry: TaskRegistry | null): ActionSummary | null {
  const named = (id: unknown) => registry?.taskName(id) || 'une tâche non identifiée'

  switch (toolName) {
    case 'mcp__todoist__add-tasks': {
      const tasks = arr<TaskInput>(input.tasks)
      if (!tasks.length) return null
      return {
        title: `Créé ${plural(tasks.length, 'une tâche', 'tâches')}`,
        lines: tasks.map((t) => ({
          head: quote(t.content),
          meta: [
            t.dueString ? frNatural(t.dueString) : null,
            t.duration || null,
            t.priority ? (PRIORITY_LABEL[t.priority] || t.priority) : null,
            arr<string>(t.labels).map((l) => `@${l}`).join(' ') || null,
          ].filter(Boolean).join(' · ') || 'sans détail',
        })),
      }
    }

    case 'mcp__todoist__update-tasks': {
      const tasks = arr<TaskInput>(input.tasks)
      if (!tasks.length) return null
      return {
        title: `Modifié ${plural(tasks.length, 'une tâche', 'tâches')}`,
        lines: tasks.map((t) => ({ head: quote(named(t.id)), meta: changesOf(t, registry) })),
      }
    }

    case 'mcp__todoist__reschedule-tasks': {
      const tasks = arr<TaskInput>(input.tasks)
      if (!tasks.length) return null
      return {
        title: `Déplacé ${plural(tasks.length, 'une tâche', 'tâches')}`,
        lines: tasks.map((t) => {
          const before = registry?.task(t.id)?.due
          return {
            head: quote(named(t.id)),
            meta: `${before ? `${frDate(before)} → ` : ''}${frDate(t.date) || 'nouvelle date'}`,
          }
        }),
      }
    }

    case 'mcp__todoist__complete-tasks': {
      const ids = arr<string>(input.ids)
      if (!ids.length) return null
      return { title: `Terminé ${plural(ids.length, 'une tâche', 'tâches')}`, lines: ids.map((id) => ({ head: quote(named(id)) })) }
    }

    case 'mcp__todoist__uncomplete-tasks': {
      const ids = arr<string>(input.ids)
      if (!ids.length) return null
      return { title: `Rouvert ${plural(ids.length, 'une tâche', 'tâches')}`, lines: ids.map((id) => ({ head: quote(named(id)) })) }
    }

    case 'mcp__todoist__delete-object': {
      if (!input.id) return null
      const what = OBJECT_LABEL[input.type ?? ''] || 'l\'élément'
      const name = input.type === 'task' ? named(input.id) : registry?.name(input.id)
      return { title: `Supprimé ${what}${name ? ` ${quote(name)}` : ''}`, lines: [] }
    }

    case 'mcp__todoist__project-move': {
      return {
        title: 'Déplacé vers un autre projet',
        lines: [{ head: quote(named(input.id ?? '')), meta: `→ ${registry?.name(input.projectId) || 'un autre projet'}` }],
      }
    }

    case 'mcp__todoist__add-projects':
    case 'mcp__todoist__add-sections':
    case 'mcp__todoist__add-labels': {
      const names = collectNames(input)
      if (!names.length) return null
      const what = toolName.endsWith('projects') ? 'projet' : toolName.endsWith('sections') ? 'section' : 'libellé'
      return { title: `Créé ${names.length > 1 ? `${names.length} ${what}s` : `un ${what}`}`, lines: names.map((n) => ({ head: quote(n) })) }
    }

    case 'Bash': {
      const command = String(input.command || '')
      if (!command) return null
      return { title: 'Commande lancée sur ton Mac', lines: [{ head: command }], mono: true }
    }

    case 'Write':
    case 'Edit': {
      const file = String(input.file_path || '')
      if (!file) return null
      const base = file.split('/').pop()
      return { title: toolName === 'Write' ? `Écrit le fichier ${base}` : `Modifié le fichier ${base}`, lines: [{ head: file }], mono: true }
    }

    default:
      return null
  }
}

/** Les champs réellement touchés par un `update-tasks`, en clair. */
function changesOf(task: TaskInput, registry: TaskRegistry | null): string {
  const changes: string[] = []
  if (task.content) changes.push(`titre → ${quote(task.content)}`)
  if (task.priority) changes.push(`priorité → ${PRIORITY_LABEL[task.priority] || task.priority}`)
  if (task.labels) changes.push(`libellés → ${arr<string>(task.labels).map((l) => `@${l}`).join(', ') || 'aucun'}`)
  if (task.duration) changes.push(`durée → ${task.duration}`)
  if (task.dueString) changes.push(task.dueString === 'remove' ? 'échéance retirée' : `échéance → ${quote(task.dueString)}`)
  if (task.deadlineDate) changes.push(`date limite → ${frDate(task.deadlineDate)}`)
  if (task.projectId) changes.push(`projet → ${registry?.name(task.projectId) || 'un autre projet'}`)
  if (task.sectionId) changes.push(`section → ${registry?.name(task.sectionId) || 'une autre section'}`)
  if (task.parentId) changes.push('devient une sous-tâche')
  if (task.description) changes.push('description modifiée')
  if (task.responsibleUser) changes.push(`assignée à ${task.responsibleUser}`)
  return changes.join(' · ') || 'aucun changement détecté'
}

function collectNames(input: ToolInput): string[] {
  for (const key of ['projects', 'sections', 'labels', 'items']) {
    const list = arr<{ name?: string, content?: string }>(input[key])
    if (list.length) return list.map((o) => o?.name || o?.content).filter((n): n is string => Boolean(n))
  }
  return input.name ? [input.name] : []
}

/** Petites traductions des dates naturelles anglaises que le modèle laisse parfois passer. */
function frNatural(due: string): string {
  return String(due)
    .replace(/\btomorrow\b/gi, 'demain')
    .replace(/\btoday\b/gi, "aujourd'hui")
    .replace(/\bnext week\b/gi, 'la semaine prochaine')
    .replace(/\bat\b/gi, 'à')
}
