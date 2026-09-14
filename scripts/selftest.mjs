// Test d'integration hors Electron : demarre une vraie session agent,
// envoie un message et verifie la connexion Todoist + une reponse.
import { AgentSession } from '../src/agent/session.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = path.join(os.tmpdir(), 'assistant-todoist-selftest')
fs.mkdirSync(workspace, { recursive: true })
const seen = { ready: null, text: '', tools: [], recaps: [], done: false }

const session = new AgentSession({
  emit: (e) => {
    if (e.k === 'ready') { seen.ready = e; console.log('READY  todoist =', e.todoist, '| modele =', e.model) }
    if (e.k === 'text-delta') seen.text += e.text
    if (e.k === 'tool-use') { seen.tools.push(e.name); console.log('OUTIL  ', e.name) }
    if (e.k === 'tool-result') console.log('RESULT ', e.name, e.ok ? 'ok' : 'ERREUR')
    if (e.k === 'recap') {
      seen.recaps.push(e)
      console.log('RECAP  ', e.items.length, 'action(s),', e.undoable, 'annulable(s)')
    }
    if (e.k === 'error') console.log('ERREUR ', e.message)
    if (e.k === 'result') seen.done = true
  },
  // Le test doit taper sur le moteur local, comme l'app : un nom de modele
  // Anthropic ici consommerait le compte Claude alors que plus rien ne l'utilise.
  getConfig: () => ({ endpoint: 'http://localhost:1234', model: 'qwen/qwen3.8-27b', contextTokens: 65536 }),
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
console.log('actions au recap :', seen.recaps.reduce((n, r) => n + r.items.length, 0))
const ok = seen.ready?.todoist === 'connected' && seen.text.trim().length > 0
console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST ECHEC')
process.exit(ok ? 0 : 1)
