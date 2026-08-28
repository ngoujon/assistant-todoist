// Garde-fous deterministes : le prompt seul ne suffit pas a garantir que l'agent
// demande avant de creer. Ces hooks PreToolUse refusent l'appel d'outil tant que
// l'information manque, et expliquent au modele quoi demander.

const OBSOLETE_LABEL = /^ancien-/i
const TYPO_LABELS = new Set(['coquille'])

const ASK_INSTRUCTIONS =
  'Pose la question à l’utilisateur dans un seul message, en liste numérotée, avec ta suggestion par défaut ' +
  'pour chaque point, puis attends sa réponse. Ne rappelle pas cet outil avant qu\'il ait répondu.'

export class TodoistGuard {
  constructor() {
    /** Libellés réellement présents dans le compte, alimentés par find-labels. */
    this.knownLabels = null
  }

  /** Mémorise les libellés dès que l'agent appelle find-labels. */
  noteToolResult(toolName, rawText) {
    if (toolName !== 'mcp__todoist__find-labels' || !rawText) return
    const names = [...String(rawText).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
    if (names.length) this.knownLabels = new Set(names.map((n) => n.toLowerCase()))
  }

  /** Configuration `hooks` a passer a query(). */
  hooks() {
    const deny = (reason) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
    const pass = { continue: true }

    return {
      PreToolUse: [
        {
          matcher: 'mcp__todoist__add-tasks',
          hooks: [async (input) => {
            const reason = this.checkAddTasks(input?.tool_input)
            return reason ? deny(reason) : pass
          }],
        },
        {
          matcher: 'mcp__todoist__update-tasks',
          hooks: [async (input) => {
            const reason = this.checkUpdateTasks(input?.tool_input)
            return reason ? deny(reason) : pass
          }],
        },
      ],
    }
  }

  // ------------------------------------------------------------------ regles

  checkAddTasks(toolInput) {
    const tasks = Array.isArray(toolInput?.tasks) ? toolInput.tasks : []
    if (!tasks.length) return null

    if (this.knownLabels === null) {
      return 'Création bloquée : tu n\'as pas encore lu les libellés du compte. ' +
        'Appelle d\'abord `mcp__todoist__find-labels`, puis applique un libellé existant à chaque tâche.'
    }

    const problems = []
    for (const task of tasks) {
      const name = task?.content || 'tâche sans nom'
      const missing = []

      if (!task?.priority) missing.push('la priorité (p1, p2, p3 ou p4)')
      if (!task?.duration) missing.push('la durée estimée')
      if (!task?.dueString && !task?.deadlineDate) {
        missing.push('le jour / l\'heure (et s\'il faut une récurrence)')
      }

      const labels = Array.isArray(task?.labels) ? task.labels.filter(Boolean).map(String) : []
      if (!labels.length) {
        missing.push('au moins un libellé @ existant')
      } else {
        const stale = labels.filter((l) => OBSOLETE_LABEL.test(l) || TYPO_LABELS.has(l.toLowerCase()))
        const unknown = labels.filter((l) => !this.knownLabels.has(l.toLowerCase()))
        if (stale.length) {
          problems.push(`« ${name} » : le libellé ${stale.map((l) => `@${l}`).join(', ')} est obsolète, choisis-en un actif.`)
        }
        const trulyUnknown = unknown.filter((l) => !stale.includes(l))
        if (trulyUnknown.length) {
          problems.push(
            `« ${name} » : le libellé ${trulyUnknown.map((l) => `@${l}`).join(', ')} n'existe pas dans le compte. ` +
            'Utilise un libellé existant, ou demande à l’utilisateur s\'il veut en créer un.',
          )
        }
      }

      if (missing.length) problems.push(`« ${name} » : il manque ${missing.join(', ')}.`)
    }

    if (!problems.length) return null
    return `Création bloquée.\n${problems.join('\n')}\n${ASK_INSTRUCTIONS}`
  }

  checkUpdateTasks(toolInput) {
    const tasks = Array.isArray(toolInput?.tasks) ? toolInput.tasks : [toolInput].filter(Boolean)
    const touchesDate = tasks.some((task) =>
      task && typeof task === 'object' && Object.keys(task).some((k) => /^due/i.test(k) || k === 'deadlineDate'),
    )
    if (!touchesDate) return null
    return 'Modification bloquée : `update-tasks` écrase la date et détruit la récurrence. ' +
      'Pour déplacer une tâche dans le temps, utilise `mcp__todoist__reschedule-tasks` — ' +
      'et annonce le déplacement à l’utilisateur avant de le lancer.'
  }
}
