// Dessine l'impact d'un déplacement : la journée avant / après, à l'échelle,
// avec les chevauchements que le changement introduit.

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

const hhmm = (minutes) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`
}

export function renderImpact(impact) {
  if (!impact?.days?.length) return null
  const root = el('div', 'impact')

  const clashing = new Set()
  for (const conflict of impact.conflicts || []) {
    clashing.add(conflict.moved)
    clashing.add(conflict.against)
  }

  for (const day of impact.days) {
    root.appendChild(renderDay(day, clashing))
  }

  for (const conflict of dedupe(impact.conflicts || [])) {
    root.appendChild(el('div', 'imp-clash', `Chevauchement : ${conflict.moved} × ${conflict.against}`))
  }

  return root
}

function renderDay(day, clashing) {
  const box = el('div', 'imp-day')
  box.appendChild(el('div', 'imp-label', day.label))

  const allDay = day.after.filter((b) => b.allDay)
  if (allDay.length) {
    const strip = el('div', 'imp-allday')
    for (const block of allDay) strip.appendChild(el('span', 'imp-chip', block.name))
    box.appendChild(strip)
  }

  // La hauteur suit l'amplitude horaire : une journée de 10 h écrasée dans 118 px
  // ne se lit pas.
  const height = Math.round(Math.min(240, Math.max(110, ((day.to - day.from) / 60) * 26)))
  const grid = el('div', 'imp-grid')
  grid.appendChild(renderHours(day, height))
  grid.appendChild(renderColumn('avant', day, day.before, clashing, false, height))
  grid.appendChild(renderColumn('après', day, day.after, clashing, true, height))
  box.appendChild(grid)
  return box
}

/** Graduation horaire : toutes les heures, ou toutes les deux si la plage est large. */
function hourMarks(day) {
  const step = day.to - day.from > 8 * 60 ? 120 : 60
  const marks = []
  for (let m = Math.ceil(day.from / step) * step; m <= day.to; m += step) marks.push(m)
  return marks
}

function renderHours(day, height) {
  const col = el('div', 'imp-hours')
  col.appendChild(el('div', 'imp-head', ''))
  const track = el('div', 'imp-track')
  track.style.height = `${height}px`
  for (const mark of hourMarks(day)) {
    const label = el('div', 'imp-hour', hhmm(mark))
    // Les graduations extrêmes se recentrent pour ne pas être coupées.
    const pct = position(mark, day)
    label.style.top = `${pct}%`
    if (pct < 6) label.style.transform = 'translateY(0)'
    if (pct > 94) label.style.transform = 'translateY(-100%)'
    track.appendChild(label)
  }
  col.appendChild(track)
  return col
}

function renderColumn(title, day, blocks, clashing, highlight, height) {
  const col = el('div', 'imp-col')
  col.appendChild(el('div', 'imp-head', title))
  const track = el('div', 'imp-track')
  track.style.height = `${height}px`

  for (const mark of hourMarks(day)) {
    const line = el('div', 'imp-line')
    line.style.top = `${position(mark, day)}%`
    track.appendChild(line)
  }

  const timed = blocks.filter((b) => !b.allDay)
  const layout = lanes(timed)
  for (const block of timed) {
    const share = ((block.end - block.start) / (day.to - day.from)) * 100
    const { lane, count } = layout.get(block)
    const node = el('div', `imp-block ${block.kind}`)
    if (highlight && clashing.has(block.name)) node.classList.add('clash')
    // Sous ~22 px un bloc ne peut porter que son nom : on lui garde une hauteur lisible.
    if (share < 19) node.classList.add('short')
    node.style.top = `${position(block.start, day)}%`
    node.style.height = `max(19px, ${share}%)`
    // Les blocs qui se chevauchent se partagent la largeur : on voit le conflit.
    if (count > 1) {
      node.style.left = `calc(2px + ${(lane * 100) / count}%)`
      node.style.width = `calc(${100 / count}% - 4px)`
      node.style.right = 'auto'
    }
    node.title = `${block.name} — ${hhmm(block.start)} → ${hhmm(block.end)}`
    node.appendChild(el('span', 'imp-time', hhmm(block.start)))
    node.appendChild(el('span', 'imp-name', block.name))
    track.appendChild(node)
  }

  if (!timed.length) track.appendChild(el('div', 'imp-empty', 'rien'))
  col.appendChild(track)
  return col
}

/** Répartit les blocs qui se chevauchent en colonnes côte à côte. */
function lanes(blocks) {
  const layout = new Map()
  const sorted = [...blocks].sort((a, b) => a.start - b.start)
  let cluster = []
  let clusterEnd = -Infinity

  const close = () => {
    const count = Math.max(1, ...cluster.map((entry) => entry.lane + 1))
    for (const entry of cluster) layout.set(entry.block, { lane: entry.lane, count })
    cluster = []
    clusterEnd = -Infinity
  }

  for (const block of sorted) {
    if (block.start >= clusterEnd) close()
    const taken = new Set(cluster.filter((e) => e.end > block.start).map((e) => e.lane))
    let lane = 0
    while (taken.has(lane)) lane += 1
    cluster.push({ block, lane, end: block.end })
    clusterEnd = Math.max(clusterEnd, block.end)
  }
  close()
  return layout
}

function position(minutes, day) {
  return ((minutes - day.from) / (day.to - day.from)) * 100
}

function dedupe(conflicts) {
  const seen = new Set()
  return conflicts.filter((c) => {
    const key = [c.moved, c.against].sort().join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
