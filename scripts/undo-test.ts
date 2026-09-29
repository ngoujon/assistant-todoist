// Qu'est-ce qui s'annule, qu'est-ce qui ne se rattrape pas — et les garde-fous.
import { TaskRegistry } from '../src/agent/registry.ts'
import { TodoistGuard } from '../src/agent/guards.ts'
import { ActionJournal } from '../src/agent/journal.ts'
import type { ToolInput } from '../src/agent/json.ts'

const registry = new TaskRegistry()
registry.note(JSON.stringify({ tasks: [
  { id: 'A', content: 'Tâche A', priority: 2, labels: ['libellé-1'], duration: { amount: 30, unit: 'minute' }, projectId: 'P1' },
  { id: 'D', content: 'Tâche B', due: { date: '2026-09-08T14:00:00' }, priority: 3, labels: ['libellé-3'], duration: { amount: 120, unit: 'minute' }, projectId: 'P1' },
  { id: 'R', content: 'Tâche R', due: { date: '2026-09-07T09:00:00', string: 'tous les mardis à 10h', isRecurring: true } },
] }))

let ko = 0
const check = (label: string, got: boolean, expected: boolean) => {
  if (got !== expected) ko++
  console.log(`${got === expected ? 'ok  ' : 'ECHEC'} ${label.padEnd(34)} -> ${got ? 'annulable' : 'non annulable'}`)
}

// Chaque cas est joué seul : le journal calcule l'inverse sur l'état d'avant.
function undoable(toolName: string, input: ToolInput, resultText = '{}'): boolean {
  const journal = new ActionJournal(registry)
  journal.noteCall('x', toolName, input)
  journal.noteResult('x', true, resultText)
  const recap = journal.closeTurn(false)
  return recap?.items[0]?.undoable ?? false
}

console.log('--- ce que le récap sait défaire ---')
check('changer un libellé', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'A', labels: ['libellé-2'] }] }), true)
check('changer la priorité', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'A', priority: 'p1' }] }), true)
check('réécrire une date existante', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'D', dueString: 'jeudi' }] }), true)
check('redater une récurrente', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'R', dueString: 'jeudi' }] }), true)
check('changer de projet', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'A', projectId: '77' }] }), true)
check('décaler', undoable('mcp__todoist__reschedule-tasks', { tasks: [{ id: 'D', date: '2026-09-09' }] }), true)
check('terminer', undoable('mcp__todoist__complete-tasks', { ids: ['A'] }), true)
check('supprimer une tâche connue', undoable('mcp__todoist__delete-object', { type: 'task', id: 'D' }), true)
check('créer (id rendu par Todoist)',
  undoable('mcp__todoist__add-tasks', { tasks: [{ content: 'Tâche N' }] },
    JSON.stringify({ tasks: [{ id: 'NEW', content: 'Tâche N' }] })), true)

console.log('\n--- ce qui ne se rattrape pas ---')
check('dater une tâche sans date', undoable('mcp__todoist__update-tasks', { tasks: [{ id: 'A', dueString: 'demain 10h30' }] }), false)
check('supprimer un projet', undoable('mcp__todoist__delete-object', { type: 'project', id: 'P1' }), false)
check('supprimer une section', undoable('mcp__todoist__delete-object', { type: 'section', id: 'S' }), false)
check('supprimer un libellé', undoable('mcp__todoist__delete-object', { type: 'label', id: 'L' }), false)
check('créer sans id en retour', undoable('mcp__todoist__add-tasks', { tasks: [{ content: 'Sans retour' }] }), false)
check('réorganiser en masse', undoable('mcp__todoist__reorder-objects', { type: 'task', items: [] }), false)
check('commande shell', undoable('Bash', { command: 'echo salut' }), false)
check('écriture de fichier', undoable('Write', { file_path: '/tmp/n.md' }), false)

console.log('\n--- l\'inverse rejoue bien à l\'envers ---')
const j = new ActionJournal(registry)
j.noteCall('1', 'mcp__todoist__reschedule-tasks', { tasks: [{ id: 'D', date: '2026-09-09T10:00:00' }] })
j.noteResult('1', true, '{}')
j.noteCall('2', 'mcp__todoist__update-tasks', { tasks: [{ id: 'D', priority: 'p1' }] })
j.noteResult('2', true, '{}')
const message = j.undoMessage(j.closeTurn(false)?.id ?? '') ?? ''
const order = [...message.matchAll(/`(mcp__todoist__[a-z-]+)`/g)].map((m) => m[1])
const expected = ['mcp__todoist__update-tasks', 'mcp__todoist__reschedule-tasks']
const inOrder = order.join(',') === expected.join(',')
if (!inOrder) ko++
console.log(`${inOrder ? 'ok  ' : 'ECHEC'} ordre inverse                     -> ${order.join(' puis ') || 'aucun'}`)
const restoresDate = message.includes('"date":"2026-09-08T14:00:00"')
if (!restoresDate) ko++
console.log(`${restoresDate ? 'ok  ' : 'ECHEC'} date d'origine rétablie            -> ${restoresDate ? 'oui' : 'non'}`)

console.log('\n--- garde-fou update-tasks ---')
let userText = ''
const guard = new TodoistGuard(registry, () => userText)
const noDate = guard.checkUpdateTasks({ tasks: [{ id: 'A', dueString: 'demain 10h30' }] })
const recurring = guard.checkUpdateTasks({ tasks: [{ id: 'R', dueString: 'demain' }] })
console.log(`${noDate === null ? 'ok  ' : 'ECHEC'} tâche sans date        -> ${noDate ? 'bloqué' : 'autorisé'}`)
console.log(`${recurring ? 'ok  ' : 'ECHEC'} tâche récurrente       -> ${recurring ? 'bloqué' : 'autorisé'}`)
if (noDate !== null) ko++
if (!recurring) ko++

// Une annulation remet des valeurs que ces règles refuseraient d'écrire en premier jet.
guard.suspend()
const suspended = guard.checkUpdateTasks({ tasks: [{ id: 'R', dueString: 'tous les mardis à 10h' }] })
guard.resume()
console.log(`${suspended === null ? 'ok  ' : 'ECHEC'} en veille (annulation) -> ${suspended ? 'bloqué' : 'autorisé'}`)
if (suspended !== null) ko++

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
