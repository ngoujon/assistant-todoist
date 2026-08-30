// Qu'est-ce qui ouvre une carte de validation, qu'est-ce qui passe seul ?
import { TaskRegistry } from '../src/agent/registry.mjs'
import { TodoistGuard } from '../src/agent/guards.mjs'

const registry = new TaskRegistry()
registry.note(JSON.stringify({ tasks: [
  { id: 'A', content: 'Tâche A', recurring: false },
  { id: 'R', content: 'Tâche R', dueDate: '2026-09-07T09:00:00', recurring: true },
] }))
let userText = ''
const guard = new TodoistGuard(registry, () => userText)

// Reproduit la règle de session.mjs sans lancer Electron.
const DISRUPTIVE = /^mcp__todoist__(reschedule|delete|move|reorder|manage|import|project-)/
function movesOrRemoves(toolName, input) {
  if (DISRUPTIVE.test(toolName)) return true
  if (toolName !== 'mcp__todoist__update-tasks') return false
  return (input?.tasks || []).some((task) => {
    const fields = Object.keys(task)
    if (fields.some((k) => /^(projectId|sectionId|parentId)$/.test(k))) return true
    if (!fields.some((k) => /^(due|deadlineDate$)/.test(k))) return false
    return Boolean(registry.task(task.id)?.due)
  })
}
function wipesContainer(toolName, input) {
  return toolName === 'mcp__todoist__delete-object' && Boolean(input?.type) && input.type !== 'task'
}
/** `auto` = mode autonome (reglage par defaut). */
function needsCard(toolName, input, auto) {
  return auto ? wipesContainer(toolName, input) : movesOrRemoves(toolName, input)
}

// Mode autonome : tout part seul, sauf ce qui efface un conteneur entier.
const autoCases = [
  ['changer un libellé', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', labels: ['libellé-1'] }] }, false],
  ['dater une tâche sans date', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', dueString: 'demain 10h30' }] }, false],
  ['réécrire une date existante', 'mcp__todoist__update-tasks', { tasks: [{ id: 'R', dueString: 'jeudi' }] }, false],
  ['changer de projet', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', projectId: '77' }] }, false],
  ['décaler', 'mcp__todoist__reschedule-tasks', { tasks: [{ id: 'R', date: '2026-09-08' }] }, false],
  ['bousculer pour caser', 'mcp__todoist__reschedule-tasks', { tasks: [{ id: 'A', date: '2026-09-09' }] }, false],
  ['réorganiser en masse', 'mcp__todoist__reorder-objects', { type: 'task', items: [] }, false],
  ['supprimer une tâche', 'mcp__todoist__delete-object', { type: 'task', id: 'A' }, false],
  ['supprimer un projet', 'mcp__todoist__delete-object', { type: 'project', id: 'P' }, true],
  ['supprimer une section', 'mcp__todoist__delete-object', { type: 'section', id: 'S' }, true],
  ['supprimer un libellé', 'mcp__todoist__delete-object', { type: 'label', id: 'L' }, true],
]

// Mode autonome décoché : on revient à « ce qui déplace ou supprime se valide ».
const manualCases = [
  ['changer un libellé', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', labels: ['libellé-1'] }] }, false],
  ['changer la priorité', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', priority: 'p2' }] }, false],
  ['régler la durée', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', duration: '15m' }] }, false],
  ['dater une tâche sans date', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', dueString: 'demain 10h30' }] }, false],
  ['réécrire une date existante', 'mcp__todoist__update-tasks', { tasks: [{ id: 'R', dueString: 'jeudi' }] }, true],
  ['changer de projet', 'mcp__todoist__update-tasks', { tasks: [{ id: 'A', projectId: '77' }] }, true],
  ['décaler', 'mcp__todoist__reschedule-tasks', { tasks: [{ id: 'R', date: '2026-09-08' }] }, true],
  ['supprimer une tâche', 'mcp__todoist__delete-object', { type: 'task', id: 'A' }, true],
]

let ko = 0
for (const [title, cases, auto] of [
  ['--- mode autonome (par défaut) ---', autoCases, true],
  ['--- mode autonome décoché ---', manualCases, false],
]) {
  console.log(title)
  for (const [label, tool, input, expected] of cases) {
    const got = needsCard(tool, input, auto)
    if (got !== expected) ko++
    console.log(`${got === expected ? 'ok  ' : 'ECHEC'} ${label.padEnd(28)} -> ${got ? 'carte' : 'passe seul'}`)
  }
  console.log('')
}

console.log('\n--- garde-fou update-tasks ---')
const noDate = guard.checkUpdateTasks({ tasks: [{ id: 'A', dueString: 'demain 10h30' }] })
const recurring = guard.checkUpdateTasks({ tasks: [{ id: 'R', dueString: 'demain' }] })
console.log(`${noDate === null ? 'ok  ' : 'ECHEC'} tâche sans date        -> ${noDate ? 'bloqué' : 'autorisé'}`)
console.log(`${recurring ? 'ok  ' : 'ECHEC'} tâche récurrente       -> ${recurring ? 'bloqué' : 'autorisé'}`)
if (noDate !== null) ko++
if (!recurring) ko++
console.log('\n--- création sans date ---')
const base = { content: 'Backlog', priority: 'p3', duration: '30m', labels: ['libellé-2'] }
guard.knownLabels = new Set(['libellé-2'])
const blocked = guard.checkAddTasks({ tasks: [base] })
userText = 'ajoute ca sans date, on verra plus tard'
const allowedByText = guard.checkAddTasks({ tasks: [base] })
userText = ''
const allowedByP4 = guard.checkAddTasks({ tasks: [{ ...base, priority: 'p4' }] })
console.log(`${blocked ? 'ok  ' : 'ECHEC'} p3 sans date, sans consigne -> ${blocked ? 'bloqué' : 'autorisé'}`)
console.log(`${allowedByText === null ? 'ok  ' : 'ECHEC'} « sans date » demandé       -> ${allowedByText ? 'bloqué' : 'autorisé'}`)
console.log(`${allowedByP4 === null ? 'ok  ' : 'ECHEC'} p4 (réservoir)              -> ${allowedByP4 ? 'bloqué' : 'autorisé'}`)
if (!blocked) ko++
if (allowedByText !== null) ko++
if (allowedByP4 !== null) ko++

console.log(ko ? `\n${ko} cas en échec` : '\nTous les cas passent')
process.exit(ko ? 1 : 0)
