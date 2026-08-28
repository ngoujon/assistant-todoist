// Prévisualisation de l'interface, sans agent : rejoue une conversation type
// puis écrit une capture PNG. Usage :
//   npx electron scripts/preview.mjs [sortie.png]
import { app, BrowserWindow, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] || path.join(root, 'preview.png')

const SCRIPT = [
  { user: 'Ajoute « tâche E » cet aprem' },
  { evt: { k: 'ready', sessionId: 'x', model: 'claude-opus-5', todoist: 'connected' } },
  { evt: { k: 'tool-use', id: 't0', name: 'mcp__todoist__find-labels', input: {} } },
  { evt: { k: 'tool-result', id: 't0', name: 'mcp__todoist__find-labels', ok: true, preview: '5 libellés' } },
  { evt: { k: 'tool-use', id: 't1', name: 'mcp__todoist__find-tasks-by-date', input: { startDate: 'today' } } },
  { evt: { k: 'tool-result', id: 't1', name: 'mcp__todoist__find-tasks-by-date', ok: true, preview: '3 tâches aujourd\'hui' } },
  { evt: { k: 'text-start' } },
  {
    evt: {
      k: 'text-delta',
      text: `Ton après-midi est **plein** : *Tâche B* 14h–16h (p2) puis *Tâche C* 16h30.\n\nAvant de poser quoi que ce soit :\n\n1. **Priorité ?** (je dirais **p2**)\n2. **Durée ?** (je dirais **30 min**)\n3. **Créneau ?** je vois deux options : **18h** ce soir, ou je décale *Tâche B* à demain 9h\n4. **Récurrent ?** (je pars sur **ponctuel**)\n\nLibellés : \`@libellé-1\` + \`@libellé-2\`.`,
    },
  },
  { evt: { k: 'result', isError: false, costUsd: 0.03, durationMs: 6400 } },
  { user: 'p2, 30 min, décale Tâche B à demain 9h, ponctuel' },
  {
    evt: {
      k: 'permission',
      id: 'p1',
      toolName: 'mcp__todoist__reschedule-tasks',
      hint: 'Cette action modifie des tâches existantes.',
      allowAlways: false,
      title: 'Déplacer « Tâche A » ?',
      summary: { lines: ['« Tâche A »\nsamedi 29 août à 9h30 → lundi 31 août à 9h45'] },
      impact: {
        days: [
          {
            day: '2026-08-31',
            label: 'lundi 31 août',
            from: 480,
            to: 900,
            before: [
              { id: 'B', name: 'Tâche B', start: 540, end: 660, kind: 'stay' },
              { id: 'C', name: 'Tâche C', start: 690, end: 735, kind: 'stay' },
              { id: 'E', name: 'Tâche D', start: 780, end: 810, kind: 'stay' },
            ],
            after: [
              { id: 'B', name: 'Tâche B', start: 540, end: 660, kind: 'stay' },
              { id: 'A', name: 'Tâche A', start: 615, end: 675, kind: 'moved' },
              { id: 'C', name: 'Tâche C', start: 690, end: 735, kind: 'stay' },
              { id: 'E', name: 'Tâche D', start: 780, end: 810, kind: 'stay' },
            ],
          },
        ],
        conflicts: [{ day: '2026-08-31', moved: 'Tâche A', against: 'Tâche B' }],
      },
      input: { tasks: [{ id: 'A', date: '2026-08-31T09:45:00' }] },
    },
  },
]

app.whenReady().then(async () => {
  if (process.env.THEME) nativeTheme.themeSource = process.env.THEME
  const win = new BrowserWindow({
    width: 470,
    height: 780,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: process.env.THEME === 'dark' ? '#1b1918' : '#f7f4f1',
    webPreferences: { preload: path.join(root, 'scripts', 'preview-preload.cjs'), contextIsolation: true },
  })

  win.webContents.on('console-message', (d) => console.log('[renderer]', d.level, d.message, d.sourceId || ''))
  await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'))

  for (const step of SCRIPT) {
    if (step.user) {
      await win.webContents.executeJavaScript(
        `(() => {
           const box = document.getElementById('input')
           box.value = ${JSON.stringify(step.user)}
           box.dispatchEvent(new Event('input'))
           document.getElementById('btn-send').click()
         })()`,
      )
    } else {
      await win.webContents.executeJavaScript(`window.assistant._fire(${JSON.stringify(step.evt)})`)
    }
    await new Promise((r) => setTimeout(r, 60))
  }

  await new Promise((r) => setTimeout(r, 700))
  console.log('theme --text :', await win.webContents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--text')"))
  console.log('messages rendus :', await win.webContents.executeJavaScript("document.querySelectorAll('#thread > *').length"))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(out, image.toPNG())
  console.log('capture :', out)

  // Verification des raccourcis clavier sur la demande de validation.
  const answeredBefore = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")
  await win.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  )
  await new Promise((r) => setTimeout(r, 200))
  const answeredAfter = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")
  const verdict = await win.webContents.executeJavaScript(
    "document.querySelector('.perm.answered .s:last-child')?.textContent || ''",
  )
  console.log(`clavier esc : ${answeredBefore} -> ${answeredAfter} carte(s) repondue(s), verdict « ${verdict} »`)

  // Verification : le composeur reste utilisable pendant un traitement.
  await win.webContents.executeJavaScript(`(() => {
    window.assistant._fire({ k: 'status', state: 'thinking' })
    const box = document.getElementById('input')
    box.value = 'et ajoute aussi le tâche R'
    box.dispatchEvent(new Event('input'))
    document.getElementById('btn-send').click()
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  const queued = await win.webContents.executeJavaScript("document.querySelectorAll('.msg.user.queued').length")
  const stillBusy = await win.webContents.executeJavaScript("document.body.classList.contains('busy')")
  const emptyAgain = await win.webContents.executeJavaScript("!document.getElementById('input').value")
  console.log(`envoi pendant traitement : ${queued} bulle(s) en file, busy=${stillBusy}, champ vide=${emptyAgain}`)

  // Le bouton doit rester « envoyer » tant qu'il y a du texte, « arreter » sinon.
  const stopWhenEmpty = await win.webContents.executeJavaScript(
    "getComputedStyle(document.querySelector('.send .ic-stop')).display",
  )
  await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('input')
    box.value = 'texte en cours'
    box.dispatchEvent(new Event('input'))
  })()`)
  const stopWhenTyping = await win.webContents.executeJavaScript(
    "getComputedStyle(document.querySelector('.send .ic-stop')).display",
  )
  console.log(`bouton stop : champ vide = ${stopWhenEmpty}, en train d'ecrire = ${stopWhenTyping}`)

  app.quit()
})
