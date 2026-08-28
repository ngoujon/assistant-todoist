import { renderMarkdown } from './markdown.js'

const api = window.assistant
const thread = document.getElementById('thread')
const scroll = document.getElementById('scroll')
const input = document.getElementById('input')
const sendBtn = document.getElementById('btn-send')
const statusLine = document.getElementById('status-line')
const settingsPanel = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const autoTodoist = document.getElementById('auto-todoist')

let busy = false
let currentText = null // { el, raw }
let currentThinking = null
let toolEls = new Map()
/** Demandes de validation encore ouvertes, dans l'ordre d'arrivée. */
const pendingPerms = []

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
  pendingPerms.length = 0
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

/** Outils dont le résumé est du texte technique : à afficher en chasse fixe. */
const MONO_TOOLS = new Set(['Bash', 'Write', 'Edit'])

// Rend un objet d'entrée lisible : « clé : valeur », sans accolades ni guillemets.
const FIELD_LABELS = {
  content: 'tâche', description: 'détail', due: 'échéance', dueString: 'échéance',
  priority: 'priorité', projectId: 'projet', sectionId: 'section', labels: 'libellés',
  deadline: 'date limite', duration: 'durée', name: 'nom', file_path: 'fichier',
  command: 'commande', url: 'adresse', query: 'recherche', searchTerm: 'recherche',
  id: 'id', ids: 'ids', assigneeId: 'assigné à', parentId: 'parent',
}

function humanizeInput(value, depth = 0, lines = []) {
  if (lines.length > 18) return lines
  if (Array.isArray(value)) {
    value.slice(0, 6).forEach((item, i) => {
      if (item && typeof item === 'object') {
        lines.push(`${'  '.repeat(depth)}${i + 1}.`)
        humanizeInput(item, depth + 1, lines)
      } else {
        lines.push(`${'  '.repeat(depth)}• ${item}`)
      }
    })
    if (value.length > 6) lines.push(`${'  '.repeat(depth)}… +${value.length - 6}`)
    return lines
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v == null || v === '') continue
      const label = FIELD_LABELS[k] || k
      if (typeof v === 'object') {
        lines.push(`${'  '.repeat(depth)}${label} :`)
        humanizeInput(v, depth + 1, lines)
      } else {
        lines.push(`${'  '.repeat(depth)}${label} : ${v}`)
      }
    }
    return lines
  }
  lines.push(`${'  '.repeat(depth)}${value}`)
  return lines
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

// -------------------------------------------------------------- permissions

function addPermission(evt) {
  finishText()
  finishThinking()
  const [glyph, label] = describeTool(evt.toolName)
  const card = el('div', `msg perm${evt.summary?.danger ? ' danger' : ''}`)
  card.appendChild(el('div', 't', evt.title || `${glyph} ${label} ?`))
  const sub = evt.subtitle || evt.reason
  if (sub) card.appendChild(el('div', 's', sub))
  if (evt.hint) card.appendChild(el('div', 's warn', evt.hint))

  const lines = evt.summary?.lines || []
  if (lines.length) {
    // Résumé en clair : on doit comprendre ce qu'on valide sans lire de JSON.
    const mono = MONO_TOOLS.has(evt.toolName)
    const box = el('div', 'summary')
    for (const line of lines) {
      const [head, ...rest] = String(line).split('\n')
      const item = el('div', mono ? 'sline mono' : 'sline')
      item.appendChild(el('span', 'head', head))
      if (rest.length) item.appendChild(el('span', 'meta', rest.join(' ')))
      box.appendChild(item)
    }
    card.appendChild(box)

    const raw = humanizeInput(evt.input).join('\n')
    if (raw) {
      const pre = el('pre', 'hidden', raw)
      const toggle = el('button', 'detail-toggle', 'Voir le détail technique')
      toggle.addEventListener('click', () => {
        const hidden = pre.classList.toggle('hidden')
        toggle.textContent = hidden ? 'Voir le détail technique' : 'Masquer le détail'
      })
      card.append(toggle, pre)
    }
  } else {
    const detail = evt.toolName === 'Bash'
      ? String(evt.input?.command || '')
      : humanizeInput(evt.input).join('\n')
    if (detail) card.appendChild(el('pre', null, detail))
  }

  const btns = el('div', 'btns')
  const entry = { id: evt.id }
  const answer = (a) => {
    if (!pendingPerms.includes(entry)) return
    pendingPerms.splice(pendingPerms.indexOf(entry), 1)
    api.replyPermission(evt.id, a)
    card.classList.add('answered')
    card.classList.remove('active')
    const verdict = a.behavior === 'allow' ? (a.always ? '✓ Toujours autorisé' : '✓ Autorisé') : '✕ Refusé'
    card.appendChild(el('div', 's', verdict))
    refreshActivePerm()
    input.focus()
  }
  entry.allow = () => answer({ behavior: 'allow' })
  entry.deny = (message) => answer({ behavior: 'deny', message: message || 'Refusé par l’utilisateur.' })
  entry.card = card
  pendingPerms.push(entry)

  const yes = el('button', 'primary')
  yes.append(document.createTextNode('Autoriser'), el('kbd', null, '↩'))
  yes.addEventListener('click', () => entry.allow())
  const no = el('button', null)
  no.append(document.createTextNode('Refuser'), el('kbd', null, 'esc'))
  no.addEventListener('click', () => entry.deny())

  // « Toujours » est volontairement absent des actions qui touchent a l'existant :
  // chaque deplacement doit etre valide un par un.
  if (evt.allowAlways) {
    const always = el('button', null, 'Toujours')
    always.addEventListener('click', () => answer({ behavior: 'allow', always: true }))
    btns.append(yes, always, no)
  } else {
    btns.append(yes, no)
  }
  card.appendChild(btns)
  card.appendChild(el('div', 'kb-hint', 'Champ vide : ↩ autorise, esc refuse.'))
  add(card)
  refreshActivePerm()
  scrollDown(true)
}

/** Met en évidence la demande qui répondra aux raccourcis clavier. */
function refreshActivePerm() {
  for (const p of pendingPerms) p.card.classList.remove('active')
  pendingPerms[0]?.card.classList.add('active')
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

  // Une demande de validation encore ouverte bloquerait l'agent sur son outil :
  // écrire autre chose vaut refus, sinon le message resterait sans effet.
  const pending = pendingPerms[0]
  if (pending) {
    pending.deny(`L’utilisateur a répondu autre chose : « ${text} »`)
    addNote('Demande refusée : tu as répondu autre chose.')
  }

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
  const pending = pendingPerms[0]
  if (pending) {
    // Entrée n'autorise que si le composeur est vide : sinon l’utilisateur est en train
    // de répondre par écrit, et sa phrase ne doit pas valider une action.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !input.value.trim()) {
      e.preventDefault()
      e.stopPropagation()
      pending.allow()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      pending.deny()
      return
    }
    return
  }
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
autoTodoist.addEventListener('change', () => api.setConfig({ autoTodoist: autoTodoist.checked }))

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
    case 'permission':
      addPermission(evt)
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
autoTodoist.checked = Boolean(state.config.autoTodoist)
showWelcome()
setBusy(false)
input.focus()
