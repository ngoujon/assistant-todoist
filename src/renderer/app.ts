import type { AgentEvent } from '../shared/types.ts'
import { renderMarkdown } from './markdown.ts'
import { renderImpact } from './impact.ts'

type EventOf<K extends AgentEvent['k']> = Extract<AgentEvent, { k: K }>

/** Un élément que index.html fournit forcément : son absence est un bug, pas un cas. */
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`élément #${id} introuvable`)
  return node as T
}

/** Un bloc en cours d'écriture : son élément et le texte brut reçu jusqu'ici. */
interface LiveBlock {
  el: HTMLElement
  raw: string
}

const api = window.assistant
const thread = byId('thread')
const scroll = byId('scroll')
const input = byId<HTMLTextAreaElement>('input')
const sendBtn = byId<HTMLButtonElement>('btn-send')
const statusLine = byId('status-line')
const settingsPanel = byId('settings')
const modelSelect = byId<HTMLSelectElement>('model')

let busy = false
let currentText: LiveBlock | null = null
let currentThinking: LiveBlock | null = null
let toolEls = new Map<string, HTMLElement>()

// ------------------------------------------------------------------ helpers

const el = (tag: string, cls?: string | null, text?: string | null): HTMLElement => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function nearBottom(): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90
}

let stick = true
scroll.addEventListener('scroll', () => { stick = nearBottom() })

function scrollDown(force?: boolean): void {
  if (force) stick = true
  if (stick) scroll.scrollTop = scroll.scrollHeight
}

function add<T extends Node>(node: T): T {
  thread.appendChild(node)
  scrollDown()
  return node
}

function clearThread(): void {
  thread.replaceChildren()
  currentText = null
  currentThinking = null
  toolEls = new Map()
  showWelcome()
}

// ------------------------------------------------------------------ accueil

const SUGGESTIONS = [
  'Qu\'est-ce que je fais aujourd\'hui ?',
  'Range ma boîte de réception Todoist',
  'Planifie ma semaine',
  'Ce qui traîne depuis trop longtemps',
]

function showWelcome(): void {
  const box = el('div', 'welcome')
  const hour = new Date().getHours()
  const greet = hour < 5 ? 'Bonne nuit' : hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir'
  box.appendChild(el('h1', null, `${greet} 👋`))
  box.appendChild(el('p', null, 'Je gère ton Todoist et ton planning. Dis-moi ce qu\'il y a à organiser, ou pioche ci-dessous.'))
  const chips = el('div', 'chips')
  for (const s of SUGGESTIONS) {
    const c = el('button', 'chip', s)
    c.addEventListener('click', () => submit(s))
    chips.appendChild(c)
  }
  box.appendChild(chips)
  thread.appendChild(box)
}

function dropWelcome(): void {
  const w = thread.querySelector('.welcome')
  if (w) w.remove()
}

// ---------------------------------------------------------- noms des outils

const TODOIST_VERBS: Record<string, string> = {
  find: 'Chercher', get: 'Lire', search: 'Chercher', fetch: 'Lire', list: 'Lister',
  add: 'Créer', update: 'Modifier', complete: 'Terminer', uncomplete: 'Rouvrir',
  delete: 'Supprimer', reschedule: 'Replanifier', move: 'Déplacer', reorder: 'Réordonner',
  analyze: 'Analyser', export: 'Exporter', import: 'Importer', manage: 'Gérer', view: 'Voir',
}
const TODOIST_NOUNS: Record<string, string> = {
  tasks: 'les tâches', task: 'la tâche', projects: 'les projets', project: 'le projet',
  sections: 'les sections', labels: 'les libellés', comments: 'les commentaires',
  filters: 'les filtres', reminders: 'les rappels', overview: 'la vue d\'ensemble',
  'completed-tasks': 'les tâches terminées', activity: 'l\'activité', assignments: 'les assignations',
  'tasks-by-date': 'l\'agenda', 'project-health': 'la santé du projet', 'user-info': 'ton profil',
}

const BUILTIN: Record<string, [string, string]> = {
  Bash: ['⌘', 'Terminal'],
  Read: ['📄', 'Lire un fichier'],
  Write: ['✏️', 'Écrire un fichier'],
  Edit: ['✏️', 'Modifier un fichier'],
  Glob: ['🔎', 'Chercher des fichiers'],
  Grep: ['🔎', 'Chercher dans les fichiers'],
  WebSearch: ['🌐', 'Recherche web'],
  WebFetch: ['🌐', 'Lire une page web'],
  TodoWrite: ['📋', 'Plan de travail'],
  Task: ['🤖', 'Sous-agent'],
}

function describeTool(name: string): [string, string] {
  if (name.startsWith('mcp__todoist__')) {
    const action = name.slice('mcp__todoist__'.length)
    const [verb = '', ...rest] = action.split('-')
    const noun = rest.join('-')
    const label = `${TODOIST_VERBS[verb] || verb} ${TODOIST_NOUNS[noun] || TODOIST_NOUNS[action] || noun || ''}`.trim()
    return ['🗒', `Todoist · ${label}`]
  }
  const builtin = BUILTIN[name]
  if (builtin) return builtin
  if (name.startsWith('mcp__')) return ['🔌', name.split('__').slice(1).join(' · ')]
  return ['•', name]
}

function summarizeInput(name: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const input = raw as Record<string, unknown>
  if (name === 'Bash') return String(input.command || '')
  if (input.file_path) return String(input.file_path).split('/').pop() ?? ''
  if (Array.isArray(input.tasks)) {
    const first = input.tasks[0] as { content?: unknown } | undefined
    return input.tasks.length > 1 ? `${input.tasks.length} tâches` : String(first?.content || '')
  }
  for (const key of ['content', 'query', 'searchTerm', 'search', 'name', 'url', 'prompt', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v)
  return first ? String(first) : ''
}

// ------------------------------------------------------------------- rendu

function pushUserMessage(text: string, queued: boolean): void {
  dropWelcome()
  finishText()
  finishThinking()
  const bubble = el('div', `msg user${queued ? ' queued' : ''}`, text)
  if (queued) bubble.appendChild(el('span', 'badge', 'ajouté au traitement en cours'))
  add(bubble)
  scrollDown(true)
}

/** Le tour est terminé : plus rien n'est « en file ». */
function clearQueuedBadges(): void {
  for (const node of thread.querySelectorAll('.msg.user.queued')) {
    node.classList.remove('queued')
    node.querySelector('.badge')?.remove()
  }
}

function startTextBlock(): LiveBlock {
  dropWelcome()
  finishThinking()
  const node = el('div', 'msg assistant md')
  const block = { el: node, raw: '' }
  currentText = block
  add(node)
  return block
}

let renderQueued = false
function appendText(chunk: string): void {
  const block = currentText ?? startTextBlock()
  block.raw += chunk
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (!currentText) return
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    scrollDown()
  })
}

function finishText(): void {
  if (currentText) {
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    if (!currentText.raw.trim()) currentText.el.remove()
  }
  currentText = null
}

function startThinking(): LiveBlock {
  finishText()
  if (currentThinking) return currentThinking
  const node = el('div', 'msg thinking')
  const block = { el: node, raw: '' }
  currentThinking = block
  add(node)
  return block
}

function appendThinking(chunk: string): void {
  const block = currentThinking ?? startThinking()
  block.raw += chunk
  block.el.textContent = block.raw
  block.el.scrollTop = block.el.scrollHeight
  scrollDown()
}

function finishThinking(): void {
  if (currentThinking) currentThinking.el.classList.add('done')
  currentThinking = null
}

function addTool(evt: EventOf<'tool-use'>): void {
  finishText()
  finishThinking()
  const [glyph, label] = describeTool(evt.name)
  const node = el('div', 'msg tool running')
  const head = el('div', 'head')
  head.appendChild(el('span', 'glyph', glyph))
  head.appendChild(el('span', 'label', label))
  const arg = summarizeInput(evt.name, evt.input)
  if (arg) head.appendChild(el('span', 'arg', arg))
  head.appendChild(el('span', 'state'))
  node.appendChild(head)

  const body = el('div', 'body')
  body.textContent = formatJson(evt.input)
  node.appendChild(body)

  head.addEventListener('click', () => node.classList.toggle('open'))
  toolEls.set(evt.id, node)
  add(node)
}

function endTool(evt: EventOf<'tool-result'>): void {
  const node = toolEls.get(evt.id)
  if (!node) return
  node.classList.remove('running')
  node.classList.add(evt.ok ? 'ok' : 'err')
  const body = node.querySelector<HTMLElement>('.body')
  if (body && evt.preview) body.textContent = `${body.textContent}\n\n— — —\n${evt.preview}`
  if (!evt.ok) node.classList.add('open')
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function addNote(text: string, kind?: string): void {
  finishText()
  add(el('div', `note${kind ? ` ${kind}` : ''}`, text))
}

// ------------------------------------------------------------------- recap

/**
 * Rien n'est soumis avant : on rend compte après. Une carte par tour, avec un bouton
 * qui rejoue les actions à l'envers — c'est le seul point de contrôle de l'app.
 */
function addRecap(evt: EventOf<'recap'>): void {
  finishText()
  finishThinking()

  const card = el('div', `msg recap${evt.undoTurn ? ' undone' : ''}`)
  const done = evt.items.filter((i) => i.state === 'done').length
  card.appendChild(el('div', 't', evt.undoTurn
    ? 'Annulation appliquée'
    : `${done || evt.items.length} ${done === 1 ? 'modification appliquée' : 'modifications appliquées'}`))

  for (const item of evt.items) {
    const block = el('div', `ritem ${item.state}`)
    const head = el('div', 'rtitle')
    head.appendChild(el('span', 'rverb', item.title))
    if (item.state === 'failed') head.appendChild(el('span', 'rtag err', 'échec'))
    else if (item.state === 'unknown') head.appendChild(el('span', 'rtag err', 'issue inconnue'))
    else if (item.note) head.appendChild(el('span', `rtag${item.undoable ? '' : ' warn'}`, item.note))
    block.appendChild(head)

    for (const line of item.lines || []) {
      const row = el('div', item.mono ? 'sline mono' : 'sline')
      row.appendChild(el('span', 'head', line.head))
      if (line.meta) row.appendChild(el('span', 'meta', line.meta))
      block.appendChild(row)
    }

    // Un déplacement se comprend mieux dessiné que raconté.
    const schema = renderImpact(item.impact)
    if (schema) block.appendChild(schema)

    card.appendChild(block)
  }

  if (!evt.undoTurn && evt.undoable) {
    const btns = el('div', 'btns')
    const undo = el('button', 'undo') as HTMLButtonElement
    undo.append(undoGlyph(), document.createTextNode(
      evt.undoable === evt.items.length ? 'Annuler' : `Annuler ce qui peut l'être (${evt.undoable}/${evt.items.length})`,
    ))
    undo.addEventListener('click', async () => {
      undo.disabled = true
      undo.textContent = 'Annulation en cours…'
      const ok = await api.undo(evt.id)
      if (ok) {
        card.classList.add('undoing')
        setBusy(true)
      } else {
        undo.textContent = 'Trop tard : plus annulable'
      }
    })
    btns.appendChild(undo)
    card.appendChild(btns)
  }

  add(card)
  scrollDown(true)
}

function undoGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M4 9h11a5 5 0 0 1 0 10h-6M4 9l4-4M4 9l4 4')
  svg.appendChild(path)
  return svg
}

// -------------------------------------------------------------------- etat

function setBusy(v: boolean): void {
  busy = v
  document.body.classList.toggle('busy', v)
  refreshComposer()
}

/**
 * Le bouton reste « envoyer » dès qu'il y a du texte, même pendant un traitement :
 * il ne devient « arrêter » que si le champ est vide.
 */
function refreshComposer(): void {
  const hasText = Boolean(input.value.trim())
  document.body.classList.toggle('has-text', hasText)
  sendBtn.disabled = !hasText && !busy
  sendBtn.setAttribute('aria-label', !hasText && busy ? 'Arrêter' : 'Envoyer')
}

function setStatus(text: string, kind?: string): void {
  statusLine.replaceChildren(el('span', `dot ${kind || ''}`), document.createTextNode(text))
}

// ------------------------------------------------------------------- envoi

function submit(forced?: string): void {
  const text = (forced ?? input.value).trim()
  if (!text) return

  // Envoi possible même pendant un traitement : le CLI fond le message dans le
  // tour en cours, l'agent le prend en compte et recalcule sa réponse.
  const queued = busy
  pushUserMessage(text, queued)
  api.send(text)
  input.value = ''
  autoGrow()
  setBusy(true)
}

function autoGrow(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`
}

input.addEventListener('input', () => {
  autoGrow()
  refreshComposer()
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy) {
    e.preventDefault()
    api.interrupt()
  }
}, true)

sendBtn.addEventListener('click', () => {
  if (busy && !input.value.trim()) api.interrupt()
  else submit()
})

byId('btn-new').addEventListener('click', () => {
  api.newChat()
  clearThread()
  setBusy(false)
  input.focus()
})

byId('btn-settings').addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden')
})

byId('btn-workspace').addEventListener('click', () => api.openWorkspace())

modelSelect.addEventListener('change', () => api.setConfig({ model: modelSelect.value }))

document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-ext]') : null
  const href = link?.getAttribute('href')
  if (!href) return
  e.preventDefault()
  api.openExternal(href)
})

// ------------------------------------------------------------- evenements

api.onEvent((evt) => {
  switch (evt.k) {
    case 'ready':
      setStatus(
        evt.todoist === 'connected' ? 'Todoist connecté' : `Todoist : ${evt.todoist}`,
        evt.todoist === 'connected' ? 'ok' : 'err',
      )
      break
    case 'status':
      // La session ne s'initialise qu'au premier message : on annonce « Prêt »,
      // et l'état Todoist s'affiche dès qu'il est réellement connu.
      if (evt.state === 'connecting') setStatus('Prêt', '')
      else if (evt.state === 'thinking') setBusy(true)
      else setBusy(false)
      break
    case 'turn-start':
      setBusy(true)
      break
    case 'text-start':
      startTextBlock()
      break
    case 'text-delta':
      appendText(evt.text)
      break
    case 'thinking-start':
      startThinking()
      break
    case 'thinking-delta':
      appendThinking(evt.text)
      break
    case 'tool-use':
      addTool(evt)
      break
    case 'tool-result':
      endTool(evt)
      break
    case 'recap':
      addRecap(evt)
      break
    case 'result':
      finishText()
      finishThinking()
      clearQueuedBadges()
      if (evt.isError && evt.text) addNote(evt.text, 'err')
      setBusy(false)
      break
    case 'interrupted':
      finishText()
      finishThinking()
      clearQueuedBadges()
      addNote('Interrompu.')
      setBusy(false)
      break
    case 'note':
      addNote(evt.text)
      break
    case 'resumed':
      addNote('Reprise de la conversation précédente.')
      break
    case 'cleared':
      clearThread()
      setBusy(false)
      break
    case 'error':
      finishText()
      finishThinking()
      addNote(evt.message, 'err')
      setBusy(false)
      break
  }
})

// ---------------------------------------------------------------- demarrage

const state = await api.init()
modelSelect.value = state.config.model
showWelcome()
setBusy(false)
input.focus()
