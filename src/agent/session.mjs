import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSystemPrompt } from './prompt.mjs'
import { TodoistGuard } from './guards.mjs'
import { TaskRegistry } from './registry.mjs'
import { summarizePermission } from './summary.mjs'
import { wasRequested } from './intent.mjs'
import { buildImpact } from './impact.mjs'

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

/** Outils Todoist en lecture seule : jamais de confirmation. */
const TODOIST_READONLY = /^mcp__todoist__(find|get|search|fetch|list|analyze|export|user-info|view)/
/** Outils qui deplacent ou suppriment, quel que soit leur contenu. */
const TODOIST_DISRUPTIVE = /^mcp__todoist__(reschedule|delete|move|reorder|manage|import|project-)/
/**
 * Regle n°2 : seul ce qui deplace ou supprime se valide. Retoucher un libelle, une
 * priorite, une duree ou un titre est reversible d'un mot : ca ne merite pas un clic.
 */
function movesOrRemoves(toolName, input, registry) {
  if (TODOIST_DISRUPTIVE.test(toolName)) return true
  if (toolName !== 'mcp__todoist__update-tasks') return false
  const tasks = Array.isArray(input?.tasks) ? input.tasks : []
  return tasks.some((task) => {
    if (!task || typeof task !== 'object') return false
    const fields = Object.keys(task)
    // Changer de projet, de section ou de parent : c'est un deplacement.
    if (fields.some((k) => /^(projectId|sectionId|parentId)$/.test(k))) return true
    if (!fields.some((k) => /^(due|deadlineDate$)/.test(k))) return false
    // Dater une tache qui n'avait pas de date revient a la creer : rien n'est bouscule.
    // Ecraser une date existante, si.
    return Boolean(registry?.task(task.id)?.due)
  })
}
/** Tout outil Todoist. */
const TODOIST_ANY = /^mcp__todoist__/
/** Outils internes sans effet de bord. */
const SAFE_BUILTIN = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'Skill', 'AskUserQuestion', 'TaskOutput',
])

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
   * @param {(req: object) => Promise<object>} deps.askPermission
   * @param {() => object} deps.getConfig               { model, autoTodoist }
   * @param {string} deps.workspace
   */
  constructor({ emit, askPermission, getConfig, workspace, tasksSnapshot }) {
    this.emit = emit
    this.askPermission = askPermission
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
    // reprise afficherait « tâche a1B2 » au lieu du nom dans les validations.
    this.registry = new TaskRegistry(tasksSnapshot)
    this.guard = new TodoistGuard(this.registry, () => this.recentUserText.join(' '))
    this.readyTimer = null
    this.retries = 0
    /**
     * Messages de l’utilisateur *dans le tour en cours* : servent a savoir s'il a demande
     * le changement. Vides a chaque fin de tour, sinon une tache nommee il y a deux
     * demandes passerait pour une consigne actuelle.
     */
    this.recentUserText = []
    /** Une tache a-t-elle ete creee dans le tour courant ? (cas du bousculage) */
    this.createdThisTurn = false
    /** Familles d'actions deja validees dans le tour : on ne redemande pas. */
    this.turnGrants = new Set()
    /** Messages envoyes mais pas encore aboutis : rejoues si la session redemarre. */
    this.unanswered = []
  }

  get running() { return this.q !== null }

  buildOptions(resume) {
    const cfg = this.getConfig()
    const claudeBin = resolveClaudeExecutable()
    return {
      cwd: this.workspace,
      additionalDirectories: [HOME],
      model: cfg.model,
      effort: 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
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
      },
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      stderr: (d) => { if (process.env.ASSISTANT_DEBUG) process.stderr.write(`[claude] ${d}`) },
      canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
    }
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
    try { this.queue?.close() } catch {}
    try { this.abort?.abort() } catch {}
    this.q = null
    this.queue = null
    this.busy = false
  }

  send(text) {
    if (!this.q) this.start({})
    this.markBusy()
    this.recentUserText.unshift(text)
    this.recentUserText.length = Math.min(this.recentUserText.length, 3)
    this.createdThisTurn = false
    this.turnGrants = new Set()
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

  async interrupt() {
    if (!this.q || !this.busy) return
    try { await this.q.interrupt() } catch {}
    this.busy = false
    this.emit({ k: 'interrupted' })
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
            if (block.name === 'mcp__todoist__add-tasks') this.createdThisTurn = true
            this.toolNames.set(block.id, block.name)
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

      case 'result':
        this.unanswered = []
        this.recentUserText = []
        this.createdThisTurn = false
        this.busy = false
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

  // ------------------------------------------------------------ permissions

  async handlePermission(toolName, input, opts) {
    const cfg = this.getConfig()
    const touchesExisting = movesOrRemoves(toolName, input, this.registry)

    if (!touchesExisting) {
      if (SAFE_BUILTIN.has(toolName)) return { behavior: 'allow', updatedInput: input }
      if (TODOIST_READONLY.test(toolName)) return { behavior: 'allow', updatedInput: input }
      if (cfg.autoTodoist && TODOIST_ANY.test(toolName)) return { behavior: 'allow', updatedInput: input }
    } else if (cfg.autoTodoist) {
      // Valider ce que l’utilisateur vient de demander n'apporte rien : la carte ne sert
      // qu'aux changements qu'il n'a pas demandes — typiquement une tache bousculee
      // pour en caser une autre.
      const intent = wasRequested({
        toolName,
        input,
        registry: this.registry,
        recentUserText: this.recentUserText,
        createdThisTurn: this.createdThisTurn,
      })
      if (intent.requested) return { behavior: 'allow', updatedInput: input }
      // Une validation par famille et par tour : valider un premier décalage vaut
      // pour les suivants du même mouvement.
      if (this.turnGrants.has(actionFamily(toolName))) {
        return { behavior: 'allow', updatedInput: input }
      }
    }

    const summary = summarizePermission(toolName, input, this.registry)
    const impact = buildImpact(toolName, input, this.registry)

    const answer = await this.askPermission({
      toolName,
      input,
      summary,
      impact,
      title: summary?.title || opts?.title,
      displayName: opts?.displayName,
      subtitle: opts?.subtitle,
      reason: opts?.decisionReason,
      hint: touchesExisting ? 'Cette action déplace ou supprime des tâches existantes.' : undefined,
      allowAlways: !touchesExisting,
      signal: opts?.signal,
    })

    if (answer?.behavior === 'allow') {
      if (touchesExisting) this.turnGrants.add(actionFamily(toolName))
      const res = { behavior: 'allow', updatedInput: input }
      if (answer.always && opts?.suggestions?.length) res.updatedPermissions = opts.suggestions
      return res
    }
    return { behavior: 'deny', message: answer?.message || 'Refuse par l\'utilisateur.' }
  }
}

/** Supprimer n'est jamais couvert par la validation d'un simple deplacement. */
function actionFamily(toolName) {
  return /delete/.test(toolName) ? 'suppression' : 'planification'
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
