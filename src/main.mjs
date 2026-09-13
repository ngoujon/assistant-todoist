import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentSession } from './agent/session.mjs'
import { PROMPT_VERSION } from './agent/prompt.mjs'
import { listLocalModels } from './agent/local-model.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = {
  // Serveur d'inférence local : l'app ne dépend plus d'un compte Claude ni de l'API
  // Anthropic. Seul Todoist reste un service distant — c'est là que vivent les tâches.
  endpoint: 'http://localhost:1234',
  model: 'qwen/qwen3.8-27b',
  /**
   * Contexte réellement chargé dans LM Studio. Le socle du CLI (outils Todoist compris)
   * pèse à lui seul ~34 000 tokens : en dessous de 65 536, la moindre question échoue.
   */
  contextTokens: 65536,
  bounds: { width: 470, height: 780 },
  lastSessionId: null,
  promptVersion: 0,
}

let config = { ...DEFAULT_CONFIG }
let configPath = ''
let workspace = ''
let win = null
let session = null
let quitting = false

// ------------------------------------------------------------------ config

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }
}

let saveTimer = null
function saveConfig() {
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
let tasksSaveTimer = null

function loadTasksSnapshot() {
  tasksPath = path.join(app.getPath('userData'), 'taches-connues.json')
  try {
    return JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
  } catch {
    return null
  }
}

function saveTasksSnapshot() {
  if (!session?.registry?.dirty) return
  clearTimeout(tasksSaveTimer)
  tasksSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(tasksPath, JSON.stringify(session.registry.snapshot()))
      session.registry.dirty = false
    } catch {}
  }, 500)
}

function ensureWorkspace() {
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

function createWindow() {
  const { width, height, x, y } = config.bounds || DEFAULT_CONFIG.bounds
  win = new BrowserWindow({
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

  win.webContents.on('did-start-loading', () => { rendererReady = false })
  if (process.env.ASSISTANT_DEBUG) {
    win.webContents.on('console-message', (d) => {
      console.log('[renderer]', d.level, d.message, `${d.sourceId || ''}:${d.lineNumber || ''}`)
    })
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    config.bounds = win.getBounds()
    saveConfig()
  }
  win.on('resize', remember)
  win.on('move', remember)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Le renderer n'ecoute qu'apres son chargement : on met les evenements de
// demarrage en attente pour ne pas perdre l'etat de connexion.
let rendererReady = false
const pendingEvents = []

function emit(evt) {
  if (process.env.ASSISTANT_DEBUG) console.log('[emit]', evt.k, rendererReady ? 'direct' : 'en attente')
  if (!rendererReady) {
    pendingEvents.push(evt)
    if (pendingEvents.length > 200) pendingEvents.shift()
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
}

function flushEvents() {
  if (process.env.ASSISTANT_DEBUG) console.log('[emit] flush de', pendingEvents.length, 'evenement(s)')
  rendererReady = true
  const queued = pendingEvents.splice(0, pendingEvents.length)
  for (const evt of queued) {
    if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
  }
}

// ---------------------------------------------------------------------- IPC

function wireIpc() {
  ipcMain.handle('app:init', () => {
    setImmediate(flushEvents)
    return {
      config: { model: config.model, endpoint: config.endpoint, contextTokens: config.contextTokens },
      workspace,
      version: app.getVersion(),
    }
  })

  ipcMain.on('chat:send', (_e, text) => {
    if (!text?.trim()) return
    session.send(text)
  })

  ipcMain.on('chat:interrupt', () => { session.interrupt() })

  ipcMain.on('chat:new', () => {
    config.lastSessionId = null
    saveConfig()
    session.start({})
  })

  ipcMain.on('chat:config', (_e, patch) => {
    const endpointChanged = patch.endpoint && patch.endpoint !== config.endpoint
    Object.assign(config, patch)
    saveConfig()
    if (patch.model) session.setModel(patch.model)
    // Changer de serveur veut dire changer d'adaptateur : la session repart dessus.
    if (endpointChanged) session.start({})
  })

  // Les modèles proposés sont ceux que le serveur local sert réellement.
  ipcMain.handle('app:models', async () => {
    try {
      return { models: await listLocalModels(config.endpoint) }
    } catch (err) {
      return { models: [], error: String(err?.message || err) }
    }
  })

  // Le récap donne l'identifiant ; la session sait quels appels inverses rejouer.
  ipcMain.handle('chat:undo', (_e, recapId) => session.undo(recapId))

  ipcMain.on('app:open-workspace', () => shell.openPath(workspace))
  ipcMain.on('app:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

function buildMenu() {
  const template = [
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
          click: () => { session.start({}); emit({ k: 'cleared' }) },
        },
        {
          // Pas d'accelerateur « Esc » : la touche est traitee dans l'interface.
          label: 'Interrompre',
          accelerator: 'CmdOrCtrl+.',
          click: () => session.interrupt(),
        },
        { type: 'separator' },
        { label: 'Ouvrir l\'espace de travail', click: () => shell.openPath(workspace) },
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

  app.whenReady().then(() => {
    app.setName('Assistant Todoist')
    nativeTheme.themeSource = 'system'
    loadConfig()
    ensureWorkspace()
    createWindow()
    buildMenu()
    wireIpc()

    session = new AgentSession({
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
    process.on('unhandledRejection', (err) => {
      emit({ k: 'error', message: `Agent indisponible : ${String(err?.message || err)}` })
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
    session.start({ resume: rulesChanged ? undefined : config.lastSessionId || undefined })

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
