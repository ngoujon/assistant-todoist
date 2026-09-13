import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSystemPrompt } from './prompt.mjs'
import { TodoistGuard } from './guards.mjs'
import { TaskRegistry } from './registry.mjs'
import { ActionJournal } from './journal.mjs'
import { startLocalBridge } from './local-model.mjs'

const HOME = os.homedir()
const require = createRequire(import.meta.url)

/** Dossiers ajoutes au PATH : une app lancee depuis le Dock n'herite pas du PATH du shell. */
const EXTRA_PATH = [
  path.join(HOME, '.local/bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

// Le SDK embarque son propre binaire Claude Code (@anthropic-ai/claude-agent-sdk-darwin-arm64)
// et le resout par chemin de module : rien a chercher dans le PATH. On ne garde ce repli
// que si le paquet natif manque (installation partielle).
function resolveClaudeExecutable() {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json')
    return undefined
  } catch {}
  for (const candidate of [path.join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

/**
 * Rien ne passe plus par une validation : l'agent exécute, l'app rend compte ensuite
 * et l’utilisateur annule d'un bouton si ça ne lui va pas. Voir `journal.mjs`.
 */

function createInputQueue() {
  const pending = []
  let waiter = null
  let closed = false
  return {
    push(msg) {
      if (waiter) { const w = waiter; waiter = null; w({ value: msg, done: false }) }
      else pending.push(msg)
    },
    close() {
      closed = true
      if (waiter) { const w = waiter; waiter = null; w({ done: true }) }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length) { yield pending.shift(); continue }
        if (closed) return
        const r = await new Promise((res) => { waiter = res })
        if (r.done) return
        yield r.value
      }
    },
  }
}

export class AgentSession {
  /**
   * @param {object} deps
   * @param {(evt: object) => void} deps.emit           envoie un evenement au renderer
   * @param {() => object} deps.getConfig               { model }
   * @param {string} deps.workspace
   */
  constructor({ emit, getConfig, workspace, tasksSnapshot }) {
    this.emit = emit
    this.getConfig = getConfig
    this.workspace = workspace
    this.q = null
    this.queue = null
    this.abort = null
    this.sessionId = null
    this.busy = false
    this.streamedMessages = new Set()
    this.toolNames = new Map()
    // La mémoire des tâches survit aux redémarrages : sans elle, une conversation
    // reprise afficherait « tâche a1B2 » au lieu du nom dans le récap — et surtout
    // n'aurait plus l'état d'avant qu'exige « Annuler ».
    this.registry = new TaskRegistry(tasksSnapshot)
    this.guard = new TodoistGuard(this.registry, () => this.recentUserText.join(' '))
    this.journal = new ActionJournal(this.registry)
    /** Le tour en cours est-il une annulation ? Son récap se lit autrement. */
    this.undoTurn = false
    this.readyTimer = null
    this.retries = 0
    /**
     * Messages de l’utilisateur *dans le tour en cours* : servent a savoir s'il a demande
     * le changement. Vides a chaque fin de tour, sinon une tache nommee il y a deux
     * demandes passerait pour une consigne actuelle.
     */
    this.recentUserText = []
    /** Messages envoyes mais pas encore aboutis : rejoues si la session redemarre. */
    this.unanswered = []
    /** Adaptateur vers le serveur d'IA local (voir local-model.mjs). */
    this.bridge = null
    this.bridgeUrl = null
    this.bridgeEndpoint = null
    this.pendingStart = null
  }

  get running() { return this.q !== null }

  buildOptions(resume) {
    const cfg = this.getConfig()
    const claudeBin = resolveClaudeExecutable()
    return {
      cwd: this.workspace,
      additionalDirectories: [HOME],
      model: cfg.model,
      // `effort` et `thinking` sont propres aux modèles Anthropic : un moteur local
      // les ignore au mieux, les refuse au pire.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemPrompt({
          workspace: this.workspace,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      },
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task'],
      strictMcpConfig: true,
      mcpServers: { todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' } },
      settingSources: ['user'],
      permissionMode: 'default',
      hooks: this.guard.hooks(),
      includePartialMessages: true,
      abortController: this.abort,
      resume: resume || undefined,
      title: 'Assistant Todoist',
      env: {
        ...process.env,
        PATH: [...new Set([...EXTRA_PATH, ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':'),
        CLAUDE_AGENT_SDK_CLIENT_APP: 'assistant-todoist/1.0.0',
        // L'inférence part vers le serveur local, via l'adaptateur : plus une requête
        // vers Anthropic, et plus besoin d'un compte Claude pour que l'app tourne.
        ANTHROPIC_BASE_URL: this.bridgeUrl,
        ANTHROPIC_AUTH_TOKEN: 'local',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: cfg.model,
        ANTHROPIC_SMALL_FAST_MODEL: cfg.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.model,
        // Le modèle local est inconnu du CLI : sans ça il suppose 200 k et compacte de travers.
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(cfg.contextTokens || 65536),
        // Rien ne doit partir vers Anthropic, pas même un ping de télémétrie.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_BUG_COMMAND: '1',
      },
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      stderr: (d) => { if (process.env.ASSISTANT_DEBUG) process.stderr.write(`[claude] ${d}`) },
      // Tout est autorisé : le contrôle se fait après coup, par le récap et son « Annuler ».
      canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    }
  }

  /**
   * Ouvre l'adaptateur vers le serveur d'IA local. Le CLI ne parle qu'à lui : il traduit
   * ce que le moteur local ne sait pas avaler, et traduit ses erreurs en français.
   */
  async ensureBridge() {
    const endpoint = this.getConfig().endpoint
    if (this.bridge && this.bridgeEndpoint === endpoint) return
    try { this.bridge?.close() } catch {}
    this.bridge = await startLocalBridge({
      upstream: endpoint,
      onNote: (message) => this.emit({ k: 'error', message }),
    })
    this.bridgeEndpoint = endpoint
    this.bridgeUrl = this.bridge.url
  }

  start({ resume, replay } = {}) {
    this.stop()
    this.abort = new AbortController()
    this.queue = createInputQueue()
    this.sessionId = null
    this.resumeId = resume || null
    this.resumeNotified = false
    this.streamedMessages = new Set()
    this.guard = new TodoistGuard(this.registry, () => this.recentUserText.join(' '))
    // Les appels en vol sont perdus par le redémarrage ; les récaps déjà rendus restent annulables.
    this.journal.reset()
    if (!this.bridgeUrl) {
      // L'adaptateur n'est pas encore prêt : on relance dès qu'il l'est.
      this.pendingStart = { resume, replay }
      this.ensureBridge().then(() => {
        const pending = this.pendingStart
        this.pendingStart = null
        if (pending) this.start(pending)
      }).catch((err) => {
        this.emit({ k: 'error', message: `Adaptateur local indisponible : ${String(err?.message || err)}` })
        this.emit({ k: 'status', state: 'idle' })
      })
      return
    }
    this.q = query({ prompt: this.queue, options: this.buildOptions(resume) })
    this.emit({ k: 'status', state: 'connecting' })
    this.pump()
    for (const message of replay || []) this.queue.push(message)
  }

  /**
   * Le CLI n'initialise la session qu'au premier message : on ne surveille donc qu'a
   * partir de la, et on relance une fois si rien ne revient.
   */
  armReadyWatchdog() {
    clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => {
      if (this.sessionId) return
      if (this.retries < 2) {
        this.retries += 1
        this.emit({ k: 'note', text: 'Connexion lente, nouvelle tentative…' })
        this.start({ replay: this.unanswered.slice() })
        return
      }
      this.emit({ k: 'error', message: "L'agent ne répond pas. Ferme et rouvre l'application." })
      this.emit({ k: 'status', state: 'idle' })
    }, 40000)
  }

  async pump() {
    const current = this.q
    try {
      for await (const msg of current) {
        if (this.q !== current) break
        this.route(msg)
      }
    } catch (err) {
      if (this.q !== current) return
      if (this.abort?.signal.aborted) return
      this.busy = false
      // Une reprise de session peut echouer si l'historique a disparu : on repart a neuf.
      if (this.resumeId) {
        this.resumeId = null
        this.emit({ k: 'note', text: 'Conversation precedente introuvable, on repart a zero.' })
        this.start({})
        return
      }
      this.emit({ k: 'error', message: String(err?.message || err) })
      this.emit({ k: 'status', state: 'idle' })
    }
  }

  stop() {
    clearTimeout(this.readyTimer)
    this.pendingStart = null
    try { this.queue?.close() } catch {}
    try { this.abort?.abort() } catch {}
    this.q = null
    this.queue = null
    this.busy = false
  }

  /**
   * @param {string} text
   * @param {{fromUser?: boolean}} [opts] une consigne d'annulation n'est pas une demande
   *   de l’utilisateur : elle ne doit pas peser sur les garde-fous qui lisent ses mots.
   */
  /** Ferme l'adaptateur : à la fermeture de l'app seulement, il survit aux redémarrages de session. */
  dispose() {
    this.stop()
    try { this.bridge?.close() } catch {}
    this.bridge = null
    this.bridgeUrl = null
  }

  send(text, { fromUser = true } = {}) {
    if (!this.q) this.start({})
    this.markBusy()
    if (fromUser) {
      this.recentUserText.unshift(text)
      this.recentUserText.length = Math.min(this.recentUserText.length, 3)
    }
    this.emit({ k: 'turn-start' })
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    }
    this.unanswered.push(message)
    this.queue.push(message)
    if (!this.sessionId) this.armReadyWatchdog()
  }

  /**
   * Un message envoyé pendant un tour est fondu dans ce tour par le CLI : on ne peut
   * donc pas compter les envois pour savoir si l'agent travaille. On suit son activité.
   */
  markBusy() {
    if (this.busy) return
    this.busy = true
    this.emit({ k: 'status', state: 'thinking' })
  }

  /**
   * Rejoue à l'envers les actions d'un récap. Les garde-fous sont mis en veille : ils
   * empêchent d'écrire n'importe quoi, pas de remettre exactement ce qui était là.
   * @returns {boolean} false si le récap n'est plus annulable.
   */
  undo(recapId) {
    const message = this.journal.undoMessage(recapId)
    if (!message) return false
    this.undoTurn = true
    this.guard.suspend()
    this.emit({ k: 'turn-start' })
    this.send(message, { fromUser: false })
    return true
  }

  async interrupt() {
    if (!this.q || !this.busy) return
    try { await this.q.interrupt() } catch {}
    this.busy = false
    // Ce qui est déjà parti chez Todoist reste fait : le récap doit quand même sortir.
    const recap = this.journal.closeTurn(this.undoTurn)
    this.undoTurn = false
    this.guard.resume()
    this.emit({ k: 'interrupted' })
    if (recap) this.emit({ k: 'recap', ...recap })
    this.emit({ k: 'status', state: 'idle' })
  }

  async setModel(model) {
    if (this.q) { try { await this.q.setModel(model) } catch {} }
  }

  // ---------------------------------------------------------------- routage

  route(msg) {
    if (process.env.ASSISTANT_DEBUG) {
      console.log('[agent]', msg.type, msg.subtype || msg.event?.type || '')
    }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          clearTimeout(this.readyTimer)
          this.retries = 0
          this.sessionId = msg.session_id
          const todoist = (msg.mcp_servers || []).find((s) => s.name === 'todoist')
          this.emit({
            k: 'ready',
            sessionId: msg.session_id,
            model: msg.model,
            todoist: todoist?.status || 'absent',
          })
          // Le CLI peut emettre plusieurs `init` par session : la note ne doit sortir qu'une fois.
          if (this.resumeId && !this.resumeNotified) {
            this.resumeNotified = true
            this.emit({ k: 'resumed' })
          }
          this.emit({ k: 'status', state: this.busy ? 'thinking' : 'idle' })
        } else if (msg.subtype === 'compact_boundary') {
          this.emit({ k: 'note', text: 'Conversation resumee pour liberer de la memoire.' })
        }
        break

      case 'stream_event': {
        this.markBusy()
        const ev = msg.event
        if (ev.type === 'message_start' && ev.message?.id) this.streamedMessages.add(ev.message.id)
        if (ev.type === 'content_block_start') {
          if (ev.content_block?.type === 'text') this.emit({ k: 'text-start' })
          if (ev.content_block?.type === 'thinking') this.emit({ k: 'thinking-start' })
        }
        if (ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d.type === 'text_delta' && d.text) this.emit({ k: 'text-delta', text: d.text })
          if (d.type === 'thinking_delta' && d.thinking) this.emit({ k: 'thinking-delta', text: d.thinking })
        }
        break
      }

      case 'assistant': {
        this.markBusy()
        const id = msg.message?.id
        const alreadyStreamed = id && this.streamedMessages.has(id)
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') {
            this.toolNames.set(block.id, block.name)
            // Avant l'exécution : c'est le dernier moment où la mémoire tient l'état d'avant.
            this.journal.noteCall(block.id, block.name, block.input)
            this.emit({ k: 'tool-use', id: block.id, name: block.name, input: block.input })
          } else if (block.type === 'text' && !alreadyStreamed && block.text?.trim()) {
            this.emit({ k: 'text-start' })
            this.emit({ k: 'text-delta', text: block.text })
          }
        }
        break
      }

      case 'user': {
        const content = msg.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const name = this.toolNames.get(block.tool_use_id) || ''
          const raw = textOf(block.content)
          this.journal.noteResult(block.tool_use_id, !block.is_error, raw)
          this.guard.noteToolResult(name, raw)
          this.registry.note(raw)
          this.emit({
            k: 'tool-result',
            id: block.tool_use_id,
            name,
            ok: !block.is_error,
            preview: truncate(raw),
          })
        }
        break
      }

      case 'rate_limit_event': {
        // Une limite d'usage atteinte se traduit par des reponses qui n'arrivent
        // jamais : autant le dire plutot que de laisser tourner le rond.
        const info = msg.rate_limit_info || {}
        if (info.status === this.lastRateStatus) break
        this.lastRateStatus = info.status
        if (info.status === 'rejected') {
          const at = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null
          this.emit({ k: 'error', message: `Limite d'usage Claude atteinte${at ? ` — ça repart vers ${at}` : ''}.` })
        } else if (info.status === 'allowed_warning') {
          const pct = info.utilization != null ? ` (${Math.round(info.utilization * 100)} %)` : ''
          this.emit({ k: 'note', text: `Tu approches la limite d'usage Claude${pct}.` })
        }
        break
      }

      case 'result': {
        this.unanswered = []
        this.recentUserText = []
        this.busy = false
        const recap = this.journal.closeTurn(this.undoTurn)
        this.undoTurn = false
        this.guard.resume()
        if (recap) this.emit({ k: 'recap', ...recap })
        this.emit({
          k: 'result',
          isError: msg.subtype !== 'success',
          text: msg.subtype !== 'success' ? (msg.result || msg.subtype) : '',
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        })
        this.emit({ k: 'status', state: 'idle' })
        break
      }
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

function truncate(s, n = 600) {
  if (!s) return ''
  const t = String(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
