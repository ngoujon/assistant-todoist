// Garde-fous deterministes : le prompt seul ne suffit pas a garantir qu'une tache
// creee soit complete. Ces hooks PreToolUse refusent l'appel d'outil tant qu'il
// manque une metadonnee — mais l'agent se debrouille seul pour la combler : il ne
// remonte jamais la question a l’utilisateur.

const OBSOLETE_LABEL = /^ancien-/i
const TYPO_LABELS = new Set(['coquille'])

const DECIDE_INSTRUCTIONS =
  'Ne pose aucune question à l’utilisateur : choisis toi-même la valeur la plus raisonnable, ' +
  'rappelle l\'outil immédiatement avec le champ rempli, et annonce ton choix en gras dans ton résumé.'

/** Formulations qui assument une tâche sans échéance. */
const NO_DATE_WANTED = /\b(sans date|pas de date|sans echeance|sans échéance|pas d.echeance|pas d.échéance|backlog|un jour|plus tard|quand j.aurai|reservoir|réservoir)\b/i

export class TodoistGuard {
  /**
   * @param {object} registry TaskRegistry, pour savoir si une tâche est récurrente
   * @param {() => string} getUserText texte récent de l’utilisateur, pour reconnaître un backlog assumé
   */
  constructor(registry, getUserText) {
    this.registry = registry
    this.getUserText = getUserText || (() => '')
    /** Libellés réellement présents dans le compte, alimentés par find-labels. */
    this.knownLabels = null
    /**
     * En veille pendant une annulation : rétablir l'état d'avant, c'est parfois
     * réécrire une valeur que ces règles refuseraient d'écrire pour la première fois.
     */
    this.suspended = false
  }

  suspend() { this.suspended = true }

  resume() { this.suspended = false }

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
    if (this.suspended) return null
    const tasks = Array.isArray(toolInput?.tasks) ? toolInput.tasks : []
    if (!tasks.length) return null

    if (this.knownLabels === null) {
      return 'Création bloquée : tu n\'as pas encore lu les libellés du compte. ' +
        'Appelle d\'abord `mcp__todoist__find-labels`, puis applique un libellé existant à chaque tâche. ' +
        'Enchaîne tout seul, sans en parler à l’utilisateur.'
    }

    const problems = []
    for (const task of tasks) {
      const name = task?.content || 'tâche sans nom'
      const missing = []

      if (!task?.priority) missing.push('la priorité (p1, p2, p3 ou p4)')
      if (!task?.duration) missing.push('la durée estimée')
      // Une tâche de réservoir (p4, ou demandée « sans date ») n'a pas à être datée.
      const datelessOk = task?.priority === 'p4' || NO_DATE_WANTED.test(this.getUserText())
      if (!task?.dueString && !task?.deadlineDate && !datelessOk) {
        missing.push('le jour / l\'heure')
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
            'Reprends le libellé existant le plus proche.',
          )
        }
      }

      if (missing.length) problems.push(`« ${name} » : il manque ${missing.join(', ')}.`)
    }

    if (!problems.length) return null
    return `Création bloquée.\n${problems.join('\n')}\n${DECIDE_INSTRUCTIONS}`
  }

  /**
   * `update-tasks` écrase la date et, avec elle, la récurrence. On ne bloque donc que
   * les tâches qu'on sait récurrentes : sur une tâche sans date, `update-tasks` est le
   * seul chemin possible — `reschedule-tasks` exige une date existante.
   */
  checkUpdateTasks(toolInput) {
    if (this.suspended) return null
    const tasks = Array.isArray(toolInput?.tasks) ? toolInput.tasks : [toolInput].filter(Boolean)
    const guilty = tasks.filter((task) => {
      if (!task || typeof task !== 'object') return false
      const touchesDate = Object.keys(task).some((k) => /^due/i.test(k) || k === 'deadlineDate')
      return touchesDate && this.registry?.task(task.id)?.recurring === true
    })
    if (!guilty.length) return null
    const names = guilty.map((t) => this.registry?.taskName(t.id) || t.id).join(', ')
    return `Modification bloquée sur une tâche récurrente (${names}) : \`update-tasks\` ` +
      'écraserait la récurrence. Utilise `mcp__todoist__reschedule-tasks` pour la déplacer. ' +
      '(Sur une tâche sans date, `update-tasks` avec `dueString` reste le bon outil.)'
  }
}
