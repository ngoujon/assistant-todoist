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
  lastSessionId: string | null
  promptVersion: number
}

const DEFAULT_CONFIG: AppConfig = {
  // L'IA, c'est Claude, par le harnais Claude Code — exactement comme dans le terminal :
  // le CLI se sert de la session déjà ouverte sur la machine, sans clé API à gérer ici.
  model: 'claude-opus-5',
  bounds: { width: 470, height: 780 },
  lastSessionId: null,
  promptVersion: 0,
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
  // Réglages d'une époque où l'inférence tournait sur un serveur local, et d'un mode
  // autonome qui n'existe plus : plus rien ne les lit.
  for (const clef of ['endpoint', 'contextTokens', 'autoTodoist']) {
    if (clef in stored) {
      delete stored[clef]
      changed = true
    }
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
      workspace,
      version: app.getVersion(),
    }
  })

  ipcMain.on('chat:send', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return
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
      getConfig: () => config,
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
