// Traduit une demande d'autorisation en français lisible : on doit savoir ce qu'on
// valide sans lire du JSON ni des identifiants.

const PRIORITY_LABEL = { p1: 'p1 — urgent', p2: 'p2 — important', p3: 'p3 — à faire', p4: 'p4 — un jour' }

const OBJECT_LABEL = {
  task: 'la tâche', project: 'le projet', section: 'la section', comment: 'le commentaire',
  label: 'le libellé', filter: 'le filtre', reminder: 'le rappel', location_reminder: 'le rappel de lieu',
}

/** « 2026-08-31T09:30:00 » -> « lundi 31 août à 9h30 ». */
export function frDate(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return value ? String(value) : null
  const [, y, mo, d, h, min] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(min || 0))
  const day = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  if (!h) return day
  return `${day} à ${Number(h)}h${min === '00' ? '' : min}`
}

const quote = (s) => `« ${String(s).trim()} »`
const plural = (n, one, many) => (n > 1 ? `${n} ${many}` : one)

/**
 * @returns {{title: string, lines: string[], danger?: boolean} | null}
 *   null = pas de résumé spécifique, l'interface retombe sur le détail brut.
 */
export function summarizePermission(toolName, input, registry) {
  const named = (id) => registry?.taskName(id) || `tâche ${String(id).slice(-4)}`

  switch (toolName) {
    case 'mcp__todoist__reschedule-tasks': {
      const tasks = arr(input?.tasks)
      if (!tasks.length) return null
      const lines = tasks.map((t) => {
        const before = registry?.task(t.id)?.due
        const after = frDate(t.date)
        const from = before ? `${frDate(before)} → ` : ''
        return `${quote(named(t.id))}\n${from}${after}`
      })
      return {
        title: tasks.length === 1
          ? `Déplacer ${quote(named(tasks[0].id))} ?`
          : `Déplacer ${tasks.length} tâches ?`,
        lines,
      }
    }

    case 'mcp__todoist__update-tasks': {
      const tasks = arr(input?.tasks)
      if (!tasks.length) return null
      const lines = tasks.map((t) => {
        const changes = []
        if (t.content) changes.push(`titre → ${quote(t.content)}`)
        if (t.priority) changes.push(`priorité → ${PRIORITY_LABEL[t.priority] || t.priority}`)
        if (t.labels) changes.push(`libellés → ${t.labels.map((l) => `@${l}`).join(', ') || 'aucun'}`)
        if (t.duration) changes.push(`durée → ${t.duration}`)
        if (t.dueString) changes.push(t.dueString === 'remove' ? 'échéance retirée' : `échéance → ${quote(t.dueString)}`)
        if (t.deadlineDate) changes.push(`date limite → ${frDate(t.deadlineDate)}`)
        if (t.projectId) changes.push(`projet → ${registry?.name(t.projectId) || 'un autre projet'}`)
        if (t.sectionId) changes.push(`section → ${registry?.name(t.sectionId) || 'une autre section'}`)
        if (t.parentId) changes.push('devient une sous-tâche')
        if (t.description) changes.push('description modifiée')
        if (t.responsibleUser) changes.push(`assignée à ${t.responsibleUser}`)
        return `${quote(named(t.id))}\n${changes.length ? changes.join(' · ') : 'aucun changement détecté'}`
      })
      return {
        title: tasks.length === 1
          ? `Modifier ${quote(named(tasks[0].id))} ?`
          : `Modifier ${tasks.length} tâches ?`,
        lines,
      }
    }

    case 'mcp__todoist__add-tasks': {
      const tasks = arr(input?.tasks)
      if (!tasks.length) return null
      const lines = tasks.map((t) => {
        const bits = [
          t.dueString ? frNatural(t.dueString) : null,
          t.duration || null,
          t.priority ? (PRIORITY_LABEL[t.priority] || t.priority) : null,
          Array.isArray(t.labels) && t.labels.length ? t.labels.map((l) => `@${l}`).join(' ') : null,
        ].filter(Boolean)
        return `${quote(t.content)}\n${bits.join(' · ') || 'sans détail'}`
      })
      return { title: `Créer ${plural(tasks.length, 'une tâche', 'tâches')} ?`, lines }
    }

    case 'mcp__todoist__complete-tasks': {
      const ids = arr(input?.ids)
      if (!ids.length) return null
      return {
        title: `Terminer ${plural(ids.length, 'une tâche', 'tâches')} ?`,
        lines: ids.map((id) => quote(named(id))),
      }
    }

    case 'mcp__todoist__uncomplete-tasks': {
      const ids = arr(input?.ids)
      if (!ids.length) return null
      return {
        title: `Rouvrir ${plural(ids.length, 'une tâche', 'tâches')} ?`,
        lines: ids.map((id) => quote(named(id))),
      }
    }

    case 'mcp__todoist__delete-object': {
      if (!input?.id) return null
      const what = OBJECT_LABEL[input.type] || 'l\'élément'
      const name = input.type === 'task' ? named(input.id) : registry?.name(input.id)
      return {
        title: `Supprimer ${what}${name ? ` ${quote(name)}` : ''} ?`,
        lines: ['Suppression définitive : cette action est irréversible.'],
        danger: true,
      }
    }

    case 'mcp__todoist__project-move': {
      return {
        title: 'Déplacer vers un autre projet ?',
        lines: [`${quote(named(input?.id ?? ''))} → ${registry?.name(input?.projectId) || 'un autre projet'}`],
      }
    }

    case 'Bash': {
      const command = String(input?.command || '')
      if (!command) return null
      return {
        title: 'Exécuter une commande sur ton Mac ?',
        lines: [command],
        danger: /\brm\b|\bsudo\b|\bdefaults write\b|\bkillall\b/.test(command),
      }
    }

    case 'Write':
    case 'Edit': {
      const file = String(input?.file_path || '')
      if (!file) return null
      const base = file.split('/').pop()
      return {
        title: toolName === 'Write' ? `Écrire le fichier ${base} ?` : `Modifier le fichier ${base} ?`,
        lines: [file],
      }
    }

    default:
      return null
  }
}

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

/** Petites traductions des dates naturelles anglaises que le modèle laisse parfois passer. */
function frNatural(due) {
  return String(due)
    .replace(/\btomorrow\b/gi, 'demain')
    .replace(/\btoday\b/gi, "aujourd'hui")
    .replace(/\bnext week\b/gi, 'la semaine prochaine')
    .replace(/\bat\b/gi, 'à')
}
