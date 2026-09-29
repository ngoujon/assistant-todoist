import { buildImpact } from '../src/agent/impact.ts'
import { TaskRegistry } from '../src/agent/registry.ts'
import type { ImpactBlock } from '../src/shared/types.ts'

const r = new TaskRegistry()
r.note(JSON.stringify({ tasks: [
  { id: 'A', content: 'Tâche A', dueDate: '2026-08-29T09:30:00', duration: '15m' },
  { id: 'B', content: 'Tâche B', dueDate: '2026-08-31T09:00:00', duration: '2h' },
  { id: 'C', content: 'Tâche C', dueDate: '2026-08-31T11:00:00', duration: '45m' },
  { id: 'D', content: 'Tâche D', dueDate: '2026-08-31' },
] }))

const impact = buildImpact('mcp__todoist__reschedule-tasks', { tasks: [{ id: 'A', date: '2026-08-31T09:45:00' }] }, r)
if (!impact) throw new Error('aucun impact calculé')
for (const day of impact.days) {
  console.log(`\n${day.label}  (${fmt(day.from)}–${fmt(day.to)})`)
  console.log('  avant :', day.before.map(desc).join(' | ') || '—')
  console.log('  après :', day.after.map(desc).join(' | ') || '—')
}
console.log('\nchevauchements :', impact.conflicts.map((c) => `${c.moved} × ${c.against}`).join(', ') || 'aucun')

function fmt(m: number | null): string {
  if (m == null) return '—'
  return `${String(Math.floor(m / 60)).padStart(2, '0')}h${String(m % 60).padStart(2, '0')}`
}
function desc(b: ImpactBlock): string { return b.allDay ? `${b.name} (journée)` : `${b.name} ${fmt(b.start)}-${fmt(b.end)} [${b.kind}]` }
