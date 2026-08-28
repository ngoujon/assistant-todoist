import { wasRequested } from '../src/agent/intent.mjs'
import { TaskRegistry } from '../src/agent/registry.mjs'

const r = new TaskRegistry()
r.note(JSON.stringify({ tasks: [
  { id: 'A', content: 'Tâche A', dueDate: '2026-08-29T09:30:00' },
  { id: 'B', content: 'Tâche B', dueDate: '2026-08-29T14:00:00' },
  { id: 'C', content: 'Tâche C', dueDate: '2026-08-28T19:00:00' },
], projects: [{ id: 'P', name: 'Projet Y' }] }))

const cases = [
  ['déplacement demandé nommément', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: '2026-08-31T09:30:00' }] }, recentUserText: ['decale Tâche A a lundi 9h30'] }, true],
  ['bousculage pour caser une nouveauté', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'B', date: '2026-08-31T09:00:00' }] }, recentUserText: ['mets la tâche D cet aprem'], createdThisTurn: true }, false],
  ['reprise pronominale', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: '2026-08-31T09:30:00' }] }, recentUserText: ['décale-la à demain 9h'] }, true],
  ['pronom mais création en cours', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'B', date: '2026-08-31T09:00:00' }] }, recentUserText: ['mets-la cet après-midi'], createdThisTurn: true }, false],
  ['deux tâches, une seule nommée', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: 'x' }, { id: 'B', date: 'y' }] }, recentUserText: ['decale Tâche A a lundi'] }, false],
  ['deux tâches toutes nommées', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: 'x' }, { id: 'C', date: 'y' }] }, recentUserText: ['decale Tâche A et Tâche C a lundi'] }, true],
  ['suppression de tâche nommée', { toolName: 'mcp__todoist__delete-object', input: { type: 'task', id: 'A' }, recentUserText: ['supprime la tache Tâche A'] }, true],
  ['suppression de projet', { toolName: 'mcp__todoist__delete-object', input: { type: 'project', id: 'P' }, recentUserText: ['supprime le projet Projet Y'] }, false],
  ['terminer une tâche nommée', { toolName: 'mcp__todoist__complete-tasks', input: { ids: ['C'] }, recentUserText: ['coche Tâche C cest fait'] }, true],
  ['modification non demandée', { toolName: 'mcp__todoist__update-tasks', input: { tasks: [{ id: 'B', priority: 'p1' }] }, recentUserText: ['organise ma semaine'] }, false],
  ['réorganisation en masse', { toolName: 'mcp__todoist__reorder-objects', input: { items: [1, 2] }, recentUserText: ['reordonne mes taches'] }, false],
  ['ensemble désigné par la date', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: 'x' }, { id: 'B', date: 'y' }] }, recentUserText: ['decale mes taches de vendredi a lundi'] }, true],
  ['ensemble « en retard »', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'A', date: 'x' }, { id: 'C', date: 'y' }] }, recentUserText: ['repousse tout ce qui est en retard a demain'] }, true],
  ['ensemble mais création en cours', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'B', date: 'y' }] }, recentUserText: ['mets la tâche D cet apres midi'], createdThisTurn: true }, false],
  ['délégation sans verbe d\'action', { toolName: 'mcp__todoist__reschedule-tasks', input: { tasks: [{ id: 'B', date: 'y' }] }, recentUserText: ['organise ma semaine'] }, false],
]

let ko = 0
for (const [label, args, expected] of cases) {
  const got = wasRequested({ ...args, registry: r })
  const ok = got.requested === expected
  if (!ok) ko++
  console.log(`${ok ? 'ok  ' : 'ECHEC'} ${label.padEnd(34)} -> ${got.requested ? 'auto' : 'carte'} (${got.reason})`)
}
console.log(ko ? `\n${ko} cas en échec` : '\nTous les cas passent')
process.exit(ko ? 1 : 0)
