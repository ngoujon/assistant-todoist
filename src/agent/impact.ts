// Modèle « avant / après » d'un déplacement : de quoi dessiner la journée touchée
// plutôt que de la décrire. Alimenté par ce que l'agent a déjà lu (TaskRegistry).

import type { Impact, ImpactBlock, ImpactConflict, ImpactDay } from '../shared/types.ts'
import { arr, type TaskInput, type ToolInput } from './json.ts'
import type { KnownTask, TaskRegistry } from './registry.ts'

/** Un instant Todoist : le jour, et l'heure en minutes si elle est connue. */
interface Moment {
  day: string
  minutes: number | null
}

interface Move {
  id: string
  name: string
  from: Moment | null
  to: Moment
  duration: number
}

interface Resident extends KnownTask {
  id: string
  moment: Moment
}

const DEFAULT_DURATION = 30
const MAX_DAYS = 3

/**
 * null si l'action ne se dessine pas (pas de date exploitable, rien de connu à afficher).
 */
export function buildImpact(toolName: string, input: ToolInput, registry: TaskRegistry | null): Impact | null {
  if (toolName !== 'mcp__todoist__reschedule-tasks') return null
  const moves: Move[] = []
  for (const entry of arr<TaskInput>(input.tasks)) {
    const task = registry?.task(entry.id)
    const to = parseMoment(entry.date)
    if (!task || !to || !entry.id) continue
    moves.push({ id: entry.id, name: task.content, from: parseMoment(task.due), to, duration: minutesOf(task.duration) })
  }
  if (!moves.length) return null

  const dayKeys = new Set<string>()
  for (const move of moves) {
    if (move.from) dayKeys.add(move.from.day)
    dayKeys.add(move.to.day)
  }
  const days = [...dayKeys].sort().slice(0, MAX_DAYS)
  const movedIds = new Set(moves.map((m) => m.id))
  const conflicts: ImpactConflict[] = []

  const model = days.map((day): ImpactDay => {
    const residents = tasksOfDay(registry, day)

    const before = residents.map((task): ImpactBlock => ({
      id: task.id,
      name: task.content,
      ...span(task.moment, minutesOf(task.duration)),
      kind: movedIds.has(task.id) ? 'leaving' : 'stay',
    }))

    const after = residents
      .filter((task) => !movedIds.has(task.id))
      .map((task): ImpactBlock => ({
        id: task.id,
        name: task.content,
        ...span(task.moment, minutesOf(task.duration)),
        kind: 'stay',
      }))

    for (const move of moves) {
      if (move.to.day !== day) continue
      after.push({ id: move.id, name: move.name, ...span(move.to, move.duration), kind: 'moved' })
    }

    after.sort(byStart)
    before.sort(byStart)

    // Chevauchements introduits par le déplacement.
    for (const block of after) {
      if (block.kind !== 'moved' || block.allDay) continue
      for (const other of after) {
        if (other === block || other.allDay) continue
        if (block.start! < other.end! && other.start! < block.end!) {
          conflicts.push({ day, moved: block.name, against: other.name })
        }
      }
    }

    return { day, label: dayLabel(day), ...window(before, after), before, after }
  })

  return { days: model, conflicts }
}

// ------------------------------------------------------------------- helpers

/** « 2026-08-31T09:30:00 » -> { day: '2026-08-31', minutes: 570 } ; date seule -> minutes null. */
function parseMoment(value: unknown): Moment | null {
  const m = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return null
  return { day: m[1]!, minutes: m[2] == null ? null : Number(m[2]) * 60 + Number(m[3]) }
}

function minutesOf(duration: string | null | undefined): number {
  if (!duration) return DEFAULT_DURATION
  const text = String(duration)
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h/i)?.[1] || 0)
  const mins = Number(text.match(/(\d+)\s*m/i)?.[1] || 0)
  const total = hours * 60 + mins
  return total > 0 ? total : DEFAULT_DURATION
}

function span(moment: Moment | null, duration: number): Pick<ImpactBlock, 'start' | 'end' | 'allDay'> {
  if (!moment || moment.minutes == null) return { start: null, end: null, allDay: true }
  return { start: moment.minutes, end: moment.minutes + duration, allDay: false }
}

function byStart(a: ImpactBlock, b: ImpactBlock): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  return (a.start ?? 0) - (b.start ?? 0)
}

function tasksOfDay(registry: TaskRegistry | null, day: string): Resident[] {
  const out: Resident[] = []
  for (const [id, task] of registry?.tasks ?? []) {
    const moment = parseMoment(task.due)
    if (moment?.day === day) out.push({ id, ...task, moment })
  }
  return out
}

/** Fenêtre horaire affichée : ce qui est occupé, arrondi à l'heure, 4 h minimum. */
function window(before: ImpactBlock[], after: ImpactBlock[]): { from: number, to: number } {
  const timed = [...before, ...after].filter((b) => !b.allDay) as Array<ImpactBlock & { start: number, end: number }>
  if (!timed.length) return { from: 8 * 60, to: 20 * 60 }
  let from = Math.min(...timed.map((b) => b.start))
  let to = Math.max(...timed.map((b) => b.end))
  from = Math.floor((from - 30) / 60) * 60
  to = Math.ceil((to + 30) / 60) * 60
  if (to - from < 240) to = from + 240
  return { from: Math.max(0, from), to: Math.min(24 * 60, to) }
}

function dayLabel(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
}
