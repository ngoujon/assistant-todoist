import { renderMarkdown } from './markdown.js'
import { renderImpact } from './impact.js'

const api = window.assistant
const thread = document.getElementById('thread')
const scroll = document.getElementById('scroll')
const input = document.getElementById('input')
const sendBtn = document.getElementById('btn-send')
const statusLine = document.getElementById('status-line')
const settingsPanel = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const endpointInput = document.getElementById('endpoint')

let busy = false
let currentText = null // { el, raw }
let currentThinking = null
let toolEls = new Map()

// ------------------------------------------------------------------ helpers

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function nearBottom() {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90
}

let stick = true
scroll.addEventListener('scroll', () => { stick = nearBottom() })

function scrollDown(force) {
  if (force) stick = true
  if (stick) scroll.scrollTop = scroll.scrollHeight
}

function add(node) {
  thread.appendChild(node)
  scrollDown()
  return node
}

function clearThread() {
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

function showWelcome() {
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

function dropWelcome() {
  const w = thread.querySelector('.welcome')
  if (w) w.remove()
}

// ---------------------------------------------------------- noms des outils

const TODOIST_VERBS = {
  find: 'Chercher', get: 'Lire', search: 'Chercher', fetch: 'Lire', list: 'Lister',
  add: 'Créer', update: 'Modifier', complete: 'Terminer', uncomplete: 'Rouvrir',
  delete: 'Supprimer', reschedule: 'Replanifier', move: 'Déplacer', reorder: 'Réordonner',
  analyze: 'Analyser', export: 'Exporter', import: 'Importer', manage: 'Gérer', view: 'Voir',
}
const TODOIST_NOUNS = {
  tasks: 'les tâches', task: 'la tâche', projects: 'les projets', project: 'le projet',
  sections: 'les sections', labels: 'les libellés', comments: 'les commentaires',
  filters: 'les filtres', reminders: 'les rappels', overview: 'la vue d\'ensemble',
  'completed-tasks': 'les tâches terminées', activity: 'l\'activité', assignments: 'les assignations',
  'tasks-by-date': 'l\'agenda', 'project-health': 'la santé du projet', 'user-info': 'ton profil',
}

const BUILTIN = {
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

function describeTool(name) {
  if (name.startsWith('mcp__todoist__')) {
    const action = name.slice('mcp__todoist__'.length)
    const [verb, ...rest] = action.split('-')
    const noun = rest.join('-')
    const label = `${TODOIST_VERBS[verb] || verb} ${TODOIST_NOUNS[noun] || TODOIST_NOUNS[action] || noun || ''}`.trim()
    return ['🗒', `Todoist · ${label}`]
  }
  if (BUILTIN[name]) return BUILTIN[name]
  if (name.startsWith('mcp__')) return ['🔌', name.split('__').slice(1).join(' · ')]
  return ['•', name]
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash') return String(input.command || '')
  if (input.file_path) return String(input.file_path).split('/').pop()
  if (Array.isArray(input.tasks)) {
    const first = input.tasks[0]
    return input.tasks.length > 1 ? `${input.tasks.length} tâches` : String(first?.content || '')
  }
  for (const key of ['content', 'query', 'searchTerm', 'search', 'name', 'url', 'prompt', 'description']) {
    if (typeof input[key] === 'string' && input[key]) return input[key]
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v)
  return first ? String(first) : ''
}

// ------------------------------------------------------------------- rendu

function pushUserMessage(text, queued) {
  dropWelcome()
  finishText()
  finishThinking()
  const bubble = el('div', `msg user${queued ? ' queued' : ''}`, text)
  if (queued) bubble.appendChild(el('span', 'badge', 'ajouté au traitement en cours'))
  add(bubble)
  scrollDown(true)
}

/** Le tour est terminé : plus rien n'est « en file ». */
function clearQueuedBadges() {
  for (const node of thread.querySelectorAll('.msg.user.queued')) {
    node.classList.remove('queued')
    node.querySelector('.badge')?.remove()
  }
}

function startTextBlock() {
  dropWelcome()
  finishThinking()
  const node = el('div', 'msg assistant md')
  currentText = { el: node, raw: '' }
  add(node)
}

let renderQueued = false
function appendText(chunk) {
  if (!currentText) startTextBlock()
  currentText.raw += chunk
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (!currentText) return
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    scrollDown()
  })
}

function finishText() {
  if (currentText) {
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    if (!currentText.raw.trim()) currentText.el.remove()
  }
  currentText = null
}

function startThinking() {
  finishText()
  if (currentThinking) return
  const node = el('div', 'msg thinking')
  currentThinking = { el: node, raw: '' }
  add(node)
}

function appendThinking(chunk) {
  if (!currentThinking) startThinking()
  currentThinking.raw += chunk
  currentThinking.el.textContent = currentThinking.raw
  currentThinking.el.scrollTop = currentThinking.el.scrollHeight
  scrollDown()
}

function finishThinking() {
  if (currentThinking) currentThinking.el.classList.add('done')
  currentThinking = null
}

function addTool(evt) {
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

function endTool(evt) {
  const node = toolEls.get(evt.id)
  if (!node) return
  node.classList.remove('running')
  node.classList.add(evt.ok ? 'ok' : 'err')
  const body = node.querySelector('.body')
  if (evt.preview) body.textContent = `${body.textContent}\n\n— — —\n${evt.preview}`
  if (!evt.ok) node.classList.add('open')
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function addNote(text, kind) {
  finishText()
  add(el('div', `note${kind ? ` ${kind}` : ''}`, text))
}

// ------------------------------------------------------------------- recap

/**
 * Rien n'est soumis avant : on rend compte après. Une carte par tour, avec un bouton
 * qui rejoue les actions à l'envers — c'est le seul point de contrôle de l'app.
 */
function addRecap(evt) {
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
    const undo = el('button', 'undo')
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

function undoGlyph() {
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

function setBusy(v) {
  busy = v
  document.body.classList.toggle('busy', v)
  refreshComposer()
}

/**
 * Le bouton reste « envoyer » dès qu'il y a du texte, même pendant un traitement :
 * il ne devient « arrêter » que si le champ est vide.
 */
function refreshComposer() {
  const hasText = Boolean(input.value.trim())
  document.body.classList.toggle('has-text', hasText)
  sendBtn.disabled = !hasText && !busy
  sendBtn.setAttribute('aria-label', !hasText && busy ? 'Arrêter' : 'Envoyer')
}

function setStatus(text, kind) {
  statusLine.replaceChildren(el('span', `dot ${kind || ''}`), document.createTextNode(text))
}

// ------------------------------------------------------------------- envoi

function submit(forced) {
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

function autoGrow() {
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

document.getElementById('btn-new').addEventListener('click', () => {
  api.newChat()
  clearThread()
  setBusy(false)
  input.focus()
})

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden')
})

document.getElementById('btn-workspace').addEventListener('click', () => api.openWorkspace())

modelSelect.addEventListener('change', () => api.setConfig({ model: modelSelect.value }))

// L'adresse ne se valide qu'une fois la saisie finie : sinon on redémarrerait la
// session à chaque caractère tapé.
endpointInput.addEventListener('change', async () => {
  const endpoint = endpointInput.value.trim()
  if (!endpoint) return
  api.setConfig({ endpoint })
  await refreshModels(modelSelect.value)
})

/** Peuple la liste avec ce que le serveur local sert vraiment. */
async function refreshModels(preferred) {
  const { models, error } = await api.models()
  modelSelect.replaceChildren()
  if (!models.length) {
    const opt = el('option', null, preferred || 'aucun modèle joignable')
    if (preferred) opt.value = preferred
    modelSelect.appendChild(opt)
    modelSelect.title = error ? `Serveur injoignable : ${error}` : ''
    return
  }
  for (const id of models) modelSelect.appendChild(Object.assign(el('option', null, id), { value: id }))
  modelSelect.title = ''
  modelSelect.value = models.includes(preferred) ? preferred : models[0]
  if (modelSelect.value !== preferred) api.setConfig({ model: modelSelect.value })
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-ext]')
  if (!link) return
  e.preventDefault()
  api.openExternal(link.getAttribute('href'))
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
endpointInput.value = state.config.endpoint || ''
await refreshModels(state.config.model)
showWelcome()
setBusy(false)
input.focus()
