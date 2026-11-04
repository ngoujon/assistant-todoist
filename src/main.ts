import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentSession } from './agent/session.ts'
import { PROMPT_VERSION } from './agent/prompt.ts'
import type { RegistrySnapshot } from './agent/registry.ts'
import type { AgentEvent, ConfigPatch, InitState } from './shared/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface AppConfig {
  model: string
  bounds: { width: number, height: number, x?: number, y?: number }
  /** Niveau de zoom d'Electron, en crans (0 = taille réelle). */
  zoom: number
  lastSessionId: string | null
  promptVersion: number
  /**
   * Libellés que l'agent ne doit jamais appliquer (`ancien-*` accepté). Propres au compte :
   * ils vivent dans config.json, sur la machine, jamais dans le dépôt.
   */
  ignoredLabels: string[]
  /** Dernières demandes envoyées, la plus récente d'abord : local, jamais dans le dépôt. */
  recentPrompts: string[]
}

const DEFAULT_CONFIG: AppConfig = {
  // L'IA, c'est Claude, par le harnais Claude Code — exactement comme dans le terminal :
  // le CLI se sert de la session déjà ouverte sur la machine, sans clé API à gérer ici.
  model: 'claude-opus-5-5',
  bounds: { width: 470, height: 780 },
  zoom: 0,
  lastSessionId: null,
  promptVersion: 0,
  ignoredLabels: [],
  recentPrompts: [],
}

const MODEL_SUCCESSORS: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-fable-5': 'claude-fable-5-1',
}

/** Combien de demandes récentes on garde pour les boutons de l'accueil. */
const RECENT_MAX = 6

/** Retient une demande en tête de liste, sans doublon (casse et espaces ignorés). */
function rememberPrompt(text: string): void {
  const clean = text.trim().replace(/\s+/g, ' ')
  // Une longue consigne ne fait pas un bon bouton : on ne garde que les demandes courtes.
  if (!clean || clean.length > 140) return
  const key = clean.toLowerCase()
  config.recentPrompts = [clean, ...config.recentPrompts.filter((p) => p.toLowerCase() !== key)].slice(0, RECENT_MAX)
  saveConfig()
}

/**
 * Premier lancement après la mise à jour : la liste est vide, alors on la remplit
 * avec les dernières demandes trouvées dans l'historique des conversations que
 * Claude Code garde pour l'espace de travail. Tout reste sur la machine.
 */
function seedRecentPrompts(): void {
  if (config.recentPrompts.length) return
  try {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude')
    const dir = path.join(base, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 10)
    const found: { ts: string, text: string }[] = []
    for (const { f } of files) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.includes('"type":"user"')) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type !== 'user' || entry.isMeta) continue
          const content = entry.message?.content
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content) && content.every((b) => b?.type === 'text')
              ? content.map((b) => b.text).join(' ')
              : ''
          if (text.trim() && !text.trimStart().startsWith('<')) found.push({ ts: String(entry.timestamp || ''), text })
        } catch {}
      }
    }
    // Du plus ancien au plus récent : chaque demande retenue passe devant la précédente.
    found.sort((a, b) => a.ts.localeCompare(b.ts))
    for (const { text } of found) rememberPrompt(text)
  } catch {}
}

let config: AppConfig = { ...DEFAULT_CONFIG }
let configPath = ''
let workspace = ''
let win: BrowserWindow | null = null
let session: AgentSession | null = null
let quitting = false

// ------------------------------------------------------------------ config

function loadConfig(): void {
  configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }
  migrateConfig()
}

/**
 * `loadConfig` étale le fichier enregistré par-dessus `DEFAULT_CONFIG` : les réglages
 * de la parenthèse « modèle local » (nom de modèle LM Studio, adresse de serveur,
 * taille de contexte) survivraient à la mise à jour et l'app demanderait à Claude un
 * modèle qui n'existe pas. On les retire plutôt que de laisser l'ancien choix décider.
 */
function migrateConfig(): void {
  let changed = false
  const stored = config as AppConfig & Record<string, unknown>
  if (!/^claude[-.]/i.test(String(config.model || ''))) {
    config.model = DEFAULT_CONFIG.model
    changed = true
  }
  // Un modèle d'une génération que le menu ne propose plus passe à son successeur,
  // sinon le menu s'afficherait vide.
  const successor = MODEL_SUCCESSORS[config.model]
  if (successor) {
    config.model = successor
    changed = true
  }
  if (!Array.isArray(config.recentPrompts)) {
    config.recentPrompts = []
    changed = true
  }
  // Réglages d'une époque où l'inférence tournait sur un serveur local, et d'un mode
  // autonome qui n'existe plus : plus rien ne les lit.
  for (const clef of ['endpoint', 'contextTokens', 'autoTodoist']) {
    if (clef in stored) {
      delete stored[clef]
      changed = true
    }
  }
  if (!Array.isArray(config.ignoredLabels)) {
    config.ignoredLabels = []
    changed = true
  }
  if (changed) saveConfig()
}

let saveTimer: NodeJS.Timeout | undefined
function saveConfig(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    } catch {}
  }, 300)
}

// --------------------------------------------------- memoire des taches vues

let tasksPath = ''
let tasksSaveTimer: NodeJS.Timeout | undefined

function loadTasksSnapshot(): Partial<RegistrySnapshot> | null {
  tasksPath = path.join(app.getPath('userData'), 'taches-connues.json')
  try {
    return JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
  } catch {
    return null
  }
}

function saveTasksSnapshot(): void {
  const registry = session?.registry
  if (!registry?.dirty) return
  clearTimeout(tasksSaveTimer)
  tasksSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(tasksPath, JSON.stringify(registry.snapshot()))
      registry.dirty = false
    } catch {}
  }, 500)
}

/**
 * Consignes propres au compte (libellés, conventions) : un fichier local, ajouté tel
 * quel au prompt. Le code reste générique, rien de personnel ne part dans le dépôt.
 */
function readPersonalNotes(): string {
  try {
    return fs.readFileSync(path.join(app.getPath('userData'), 'consignes.md'), 'utf8')
  } catch {
    return ''
  }
}

function ensureWorkspace(): void {
  workspace = path.join(app.getPath('userData'), 'Espace de travail')
  fs.mkdirSync(workspace, { recursive: true })
  const readme = path.join(workspace, 'LISEZ-MOI.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '# Espace de travail de l\'Assistant Todoist',
      '',
      'C\'est ici que l\'assistant range les notes, plans et brouillons qu\'il produit.',
      'Tu peux y déposer tes propres fichiers : il sait les lire.',
      '',
    ].join('\n'))
  }
}

// ------------------------------------------------------------------ fenetre

function createWindow(): void {
  const { width, height, x, y } = config.bounds || DEFAULT_CONFIG.bounds
  const window = new BrowserWindow({
    width, height, x, y,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'Assistant Todoist',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win = window

  window.webContents.on('did-start-loading', () => { rendererReady = false })
  // Un changement de page remet le zoom à zéro : on le repose à chaque chargement.
  window.webContents.on('did-finish-load', () => window.webContents.setZoomLevel(config.zoom || 0))
  window.webContents.on('before-input-event', (e, input) => {
    const steps = zoomFromKey(input)
    if (steps === null) return
    e.preventDefault()
    if (steps === 0) applyZoom(0)
    else zoomBy(steps)
  })
  if (process.env.ASSISTANT_DEBUG) {
    window.webContents.on('console-message', (d) => {
      console.log('[renderer]', d.level, d.message, `${d.sourceId || ''}:${d.lineNumber || ''}`)
    })
  }
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  window.once('ready-to-show', () => window.show())

  window.on('close', (e) => {
    if (!quitting) { e.preventDefault(); window.hide() }
  })
  const remember = () => {
    if (window.isDestroyed() || window.isMinimized()) return
    config.bounds = window.getBounds()
    saveConfig()
  }
  window.on('resize', remember)
  window.on('move', remember)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // La fenêtre n'affiche que l'interface embarquée : toute navigation ailleurs est
  // refusée, et un lien web part dans le navigateur.
  window.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

// --------------------------------------------------------------------- zoom

// Le zoom d'Electron est logarithmique : un cran vaut 20 % de plus. On borne
// pour que l'interface reste utilisable, et on garde le réglage d'une fois sur l'autre.
const ZOOM_MIN = -4
const ZOOM_MAX = 6

function applyZoom(steps: number): void {
  const n = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(steps)))
  config.zoom = n
  if (win && !win.isDestroyed()) win.webContents.setZoomLevel(n)
  saveConfig()
}

function zoomBy(delta: number): void {
  applyZoom((config.zoom || 0) + delta)
}

/**
 * Les touches de zoom, lues avant la page : ⌘= comme ⌘+ (le « + » d'un clavier
 * français demande Maj), ⌘−, ⌘0 et le pavé numérique. Un menu ne porte qu'un
 * raccourci, d'où ce rattrapage. Renvoie +1, -1, 0 (taille réelle) ou null.
 */
function zoomFromKey(input: Electron.Input): number | null {
  if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return null
  const { key, code } = input
  if (key === '+' || key === '=' || code === 'NumpadAdd') return +1
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return -1
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 0
  return null
}

// Le renderer n'ecoute qu'apres son chargement : on met les evenements de
// demarrage en attente pour ne pas perdre l'etat de connexion.
let rendererReady = false
const pendingEvents: AgentEvent[] = []

function emit(evt: AgentEvent): void {
  if (process.env.ASSISTANT_DEBUG) console.log('[emit]', evt.k, rendererReady ? 'direct' : 'en attente')
  if (!rendererReady) {
    pendingEvents.push(evt)
    if (pendingEvents.length > 200) pendingEvents.shift()
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
}

function flushEvents(): void {
  if (process.env.ASSISTANT_DEBUG) console.log('[emit] flush de', pendingEvents.length, 'evenement(s)')
  rendererReady = true
  const queued = pendingEvents.splice(0, pendingEvents.length)
  for (const evt of queued) {
    if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
  }
}

// ---------------------------------------------------------------------- IPC

function wireIpc(): void {
  ipcMain.handle('app:init', (): InitState => {
    setImmediate(flushEvents)
    return {
      config: { model: config.model },
      recentPrompts: [...config.recentPrompts],
      workspace,
      version: app.getVersion(),
    }
  })

  ipcMain.on('chat:send', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return
    rememberPrompt(text)
    session?.send(text)
  })

  ipcMain.on('chat:interrupt', () => { void session?.interrupt() })

  ipcMain.on('chat:new', () => {
    config.lastSessionId = null
    saveConfig()
    session?.start({})
  })

  // La page ne règle que le modèle : rien d'autre de la config ne lui est ouvert.
  ipcMain.on('chat:config', (_e, patch: ConfigPatch) => {
    if (typeof patch?.model !== 'string' || !patch.model) return
    config.model = patch.model
    saveConfig()
    void session?.setModel(patch.model)
  })

  // Le récap donne l'identifiant ; la session sait quels appels inverses rejouer.
  ipcMain.handle('chat:undo', (_e, recapId: unknown) => typeof recapId === 'string' && session ? session.undo(recapId) : false)

  ipcMain.on('app:open-workspace', () => { void shell.openPath(workspace) })
  ipcMain.on('app:open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'À propos de l\'Assistant Todoist' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Conversation',
      submenu: [
        {
          label: 'Nouvelle conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => { session?.start({}); emit({ k: 'cleared' }) },
        },
        {
          // Pas d'accelerateur « Esc » : la touche est traitee dans l'interface.
          label: 'Interrompre',
          accelerator: 'CmdOrCtrl+.',
          click: () => { void session?.interrupt() },
        },
        { type: 'separator' },
        { label: 'Ouvrir l\'espace de travail', click: () => { void shell.openPath(workspace) } },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Affichage',
      submenu: [
        // Les touches sont lues avant la page (voir zoomFromKey) : ces raccourcis
        // ne servent qu'à les afficher dans le menu.
        { label: 'Agrandir', accelerator: 'CmdOrCtrl+Plus', click: () => zoomBy(+1) },
        { label: 'Réduire', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-1) },
        { label: 'Taille réelle', accelerator: 'CmdOrCtrl+0', click: () => applyZoom(0) },
      ],
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'close', label: 'Fermer' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// -------------------------------------------------------------- cycle de vie

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })

  void app.whenReady().then(() => {
    app.setName('Assistant Todoist')
    nativeTheme.themeSource = 'system'
    loadConfig()
    ensureWorkspace()
    seedRecentPrompts()
    createWindow()
    buildMenu()
    wireIpc()

    const agent = new AgentSession({
      emit: (evt) => {
        if (evt.k === 'ready' && evt.sessionId) {
          config.lastSessionId = evt.sessionId
          saveConfig()
        }
        if (evt.k === 'result') saveTasksSnapshot()
        emit(evt)
      },
      getConfig: () => ({ ...config, personalNotes: readPersonalNotes() }),
      workspace,
      tasksSnapshot: loadTasksSnapshot(),
    })
    // Filet de securite : une panne au demarrage de l'agent doit se voir dans l'interface,
    // pas seulement dans la console.
    session = agent
    process.on('unhandledRejection', (err) => {
      emit({ k: 'error', message: `Agent indisponible : ${err instanceof Error ? err.message : String(err)}` })
      emit({ k: 'status', state: 'idle' })
    })

    // On reprend la derniere conversation : l'assistant garde le contexte du jour.
    // Sauf si les regles metier ont change depuis : mieux vaut repartir propre que
    // laisser l'ancien comportement s'ancrer dans l'historique.
    const rulesChanged = config.promptVersion !== PROMPT_VERSION
    if (rulesChanged) {
      config.promptVersion = PROMPT_VERSION
      config.lastSessionId = null
      saveConfig()
    }
    agent.start({ resume: rulesChanged ? undefined : config.lastSessionId || undefined })

    app.on('activate', () => {
      if (win) { win.show(); win.focus() }
      else createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    session?.dispose()
  })

  app.on('window-all-closed', () => { /* l'app reste dans le Dock */ })
}
