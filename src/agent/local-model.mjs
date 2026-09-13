// Adaptateur entre le CLI Claude Code et un serveur d'inférence local (LM Studio).
//
// Le CLI parle l'API Messages d'Anthropic, que LM Studio implémente — mais deux
// détails coincent, et c'est tout l'objet de ce fichier :
//
// 1. Le CLI glisse des messages `role:"system"` *en cours* de conversation. Le gabarit
//    de chat de Qwen refuse net (« System message must be at the beginning ») et
//    renvoie une 500 illisible. On replie ces messages en messages utilisateur.
// 2. Les erreurs du moteur local remontent en charabia JSON imbriqué. On les traduit,
//    parce que « contexte trop court » est un réglage à changer, pas une panne.

import http from 'node:http'

/** Repli d'un message système hors position initiale, que Qwen refuse. */
function foldSystemMessages(payload) {
  if (!Array.isArray(payload?.messages)) return false
  let folded = false
  payload.messages = payload.messages.map((msg) => {
    if (msg?.role !== 'system') return msg
    folded = true
    const text = typeof msg.content === 'string'
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.map((b) => b?.text || '').join('\n') : '')
    return { role: 'user', content: `[consigne système] ${text}` }
  })
  return folded
}

/** Traduit une erreur du moteur local en phrase actionnable. */
export function explainUpstreamError(raw) {
  const text = String(raw || '')
  const tokens = text.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/)
  if (tokens) {
    const [, need, have] = tokens
    return `Le modèle local est chargé avec ${Number(have).toLocaleString('fr-FR')} tokens de contexte, ` +
      `et cette requête en demande ${Number(need).toLocaleString('fr-FR')}. ` +
      'Dans LM Studio, recharge le modèle avec au moins 65 536 tokens de contexte.'
  }
  if (/Context size has been exceeded/i.test(text)) {
    return 'Le contexte du modèle local est saturé. Recharge-le avec un contexte plus grand dans LM Studio, ' +
      'ou démarre une nouvelle conversation.'
  }
  if (/System message must be at the beginning/i.test(text)) {
    return 'Le gabarit de chat du modèle local refuse les consignes système en cours de conversation.'
  }
  if (/model_not_found|No models loaded/i.test(text)) {
    return 'Aucun modèle n\'est chargé dans LM Studio, ou le nom du modèle ne correspond pas.'
  }
  return null
}

/**
 * Démarre l'adaptateur sur 127.0.0.1 et renvoie l'URL à donner au CLI.
 * @param {object} opts
 * @param {string} opts.upstream      base du serveur local, ex. http://localhost:1234
 * @param {(msg: string) => void} [opts.onNote]  pour faire remonter une erreur lisible
 * @returns {Promise<{url: string, close: () => void}>}
 */
export function startLocalBridge({ upstream, onNote }) {
  const base = String(upstream || '').replace(/\/+$/, '')

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let body = Buffer.concat(chunks)

      if (body.length && /\/v1\/messages/.test(req.url || '')) {
        try {
          const payload = JSON.parse(body.toString('utf8'))
          if (foldSystemMessages(payload)) body = Buffer.from(JSON.stringify(payload))
        } catch {
          // Corps illisible : on le laisse passer tel quel, le serveur tranchera.
        }
      }

      let upstreamRes
      try {
        upstreamRes = await fetch(base + req.url, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        })
      } catch (err) {
        onNote?.(`Serveur d'IA local injoignable sur ${base} — vérifie que LM Studio tourne.`)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err?.message || err) } }))
        return
      }

      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') || 'application/json',
      })
      if (!upstreamRes.body) { res.end(); return }

      // On relaie tel quel, en surveillant le flux pour expliquer une erreur au passage.
      const reader = upstreamRes.body.getReader()
      let sniffed = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (sniffed.length < 4000) sniffed += Buffer.from(value).toString('utf8')
        res.write(Buffer.from(value))
      }
      res.end()
      if (upstreamRes.status >= 400 || sniffed.includes('"type":"error"')) {
        const explained = explainUpstreamError(sniffed)
        if (explained) onNote?.(explained)
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    // Port éphémère : rien à réserver, rien à libérer au prochain lancement.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

/** Liste les modèles servis par le serveur local, pour peupler les réglages. */
export async function listLocalModels(upstream) {
  const base = String(upstream || '').replace(/\/+$/, '')
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  // On écarte les modèles d'embedding : ils ne savent pas dialoguer.
  return (data?.data || [])
    .map((m) => String(m?.id || ''))
    .filter((id) => id && !/embed/i.test(id))
}
