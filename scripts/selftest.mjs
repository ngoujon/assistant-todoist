// Test d'integration hors Electron : demarre une vraie session agent,
// envoie un message et verifie la connexion Todoist + une reponse.
import { AgentSession } from '../src/agent/session.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = path.join(os.tmpdir(), 'assistant-todoist-selftest')
fs.mkdirSync(workspace, { recursive: true })
const seen = { ready: null, text: '', tools: [], perms: [], done: false }

const session = new AgentSession({
  emit: (e) => {
    if (e.k === 'ready') { seen.ready = e; console.log('READY  todoist =', e.todoist, '| modele =', e.model) }
    if (e.k === 'text-delta') seen.text += e.text
    if (e.k === 'tool-use') { seen.tools.push(e.name); console.log('OUTIL  ', e.name) }
    if (e.k === 'tool-result') console.log('RESULT ', e.name, e.ok ? 'ok' : 'ERREUR')
    if (e.k === 'error') console.log('ERREUR ', e.message)
    if (e.k === 'result') seen.done = true
  },
  askPermission: async (req) => {
    seen.perms.push(req.toolName)
    console.log('PERM   demandee pour', req.toolName, '->', req.title || '')
    return { behavior: 'deny', message: 'test automatique' }
  },
  getConfig: () => ({ model: 'claude-sonnet-5', autoTodoist: false }),
  workspace,
})

session.start({})
session.send("Combien ai-je de projets Todoist ? Reponds en une phrase, sans rien modifier.")

const started = Date.now()
while (!seen.done && Date.now() - started < 150000) {
  await new Promise((r) => setTimeout(r, 300))
}
session.stop()

console.log('\n--- reponse ---\n' + seen.text.trim().slice(0, 400))
console.log('\noutils appeles :', seen.tools.join(', ') || 'aucun')
console.log('permissions demandees :', seen.perms.join(', ') || 'aucune')
const ok = seen.ready?.todoist === 'connected' && seen.text.trim().length > 0
console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST ECHEC')
process.exit(ok ? 0 : 1)
