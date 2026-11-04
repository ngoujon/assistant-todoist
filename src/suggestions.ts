// Les boutons de l'accueil : ce que l'utilisateur demande le plus souvent.
// Deux demandes ne se ressemblent presque jamais mot pour mot (« déplace X à samedi »,
// « déplace Y à lundi »), alors on compte par genre de demande, pas par phrase exacte.
import type { Suggestion } from './shared/types.ts'

interface Intent {
  label: string
  /** Début de phrase posé dans le champ : l'utilisateur complète puis envoie. */
  starter: string
  match: RegExp
}

// L'ordre compte : la première famille qui reconnaît la demande l'emporte.
// Les motifs tolèrent les fautes de frappe courantes et l'absence d'accents.
const INTENTS: Intent[] = [
  { label: '⏰ Mettre un rappel', starter: 'Mets un rappel ', match: /\brappel/ },
  { label: '↪️ Déplacer une tâche', starter: 'Déplace la tâche ', match: /\b(deplac|depalc|repouss|reprogramm|decal|report)/ },
  { label: '🗑 Supprimer ou terminer', starter: 'Supprime la tâche ', match: /\b(supprim|efface|vide|termin|coche|enleve|retire)/ },
  { label: '✏️ Modifier une tâche', starter: 'Modifie la tâche ', match: /\b(modifi|change|renomm|corrig)/ },
  { label: '🗓 Organiser le planning', starter: 'Organise ', match: /\b(planifi|organis|range|tri[ea]?\b|prepare.*semaine)/ },
  // Avant l'ajout : « qu'est-ce que je fais » n'est pas « fais une tâche ».
  // Seuls les débuts de phrase comptent — « tu peux mettre… ? » reste un ajout.
  { label: '🔎 Poser une question', starter: '', match: /^(c'est quand|quand|qu'est|quoi|quel|combien|ou en|sors|liste|montre)/ },
  { label: '➕ Ajouter une tâche', starter: 'Ajoute une tâche ', match: /\b(met|mets|ajout|ajotu|ajoute|rajout|fais|cree|creer|programme|bloque)\b|\b(tache|evenement|evenemtn|rdv|rendez)/ },
]

/** Minuscules, sans accents ni espaces superflus : la clé de comparaison. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Les `max` suggestions les plus fréquentes. Une demande répétée mot pour mot (au moins
 * deux fois) passe en premier et s'envoie telle quelle ; sinon on propose les familles
 * de demandes les plus courantes, qui préremplissent le champ.
 */
export function frequentSuggestions(history: string[], max = 4): Suggestion[] {
  const exact = new Map<string, { text: string, count: number }>()
  const byIntent = new Map<Intent, number>()

  for (const raw of history) {
    const text = raw.trim().replace(/\s+/g, ' ')
    if (!text) continue
    const key = normalize(text)
    const seen = exact.get(key)
    // On garde la formulation la plus récente (l'historique va du plus ancien au plus récent).
    exact.set(key, { text, count: (seen?.count ?? 0) + 1 })
    const intent = INTENTS.find((i) => i.match.test(key))
    if (intent) byIntent.set(intent, (byIntent.get(intent) ?? 0) + 1)
  }

  const out: Suggestion[] = []
  const repeated = [...exact.values()]
    .filter((e) => e.count >= 2 && e.text.length <= 80)
    .sort((a, b) => b.count - a.count)
  for (const e of repeated.slice(0, 2)) out.push({ label: e.text, text: e.text, send: true, count: e.count })

  const intents = [...byIntent.entries()]
    .filter(([i]) => i.starter)
    .sort((a, b) => b[1] - a[1])
  for (const [intent, count] of intents) {
    if (out.length >= max) break
    out.push({ label: intent.label, text: intent.starter, send: false, count })
  }
  return out
}
