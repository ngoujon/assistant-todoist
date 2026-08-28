// Distingue « le changement que l’utilisateur vient de demander » de « un changement que
// l'agent décide tout seul, qui bouscule autre chose ». Seul le second se valide.

const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'au', 'aux', 'en',
  'pour', 'avec', 'dans', 'sur', 'par', 'que', 'qui', 'mon', 'ma', 'mes', 'ce', 'cette',
  'ces', 'son', 'sa', 'ses', 'the', 'to', 'of', 'faire', 'task', 'tache', 'taches',
])

/** Verbes qui expriment une demande de déplacement / modification / suppression. */
const ACTION_VERBS = /\b(decale|decaler|deplace|deplacer|bouge|bouger|reporte|reporter|replanifie|replanifier|repousse|repousser|avance|avancer|mets|met|mettre|change|changer|modifie|modifier|renomme|renommer|supprime|supprimer|efface|effacer|annule|annuler|passe|passer|repasse|termine|terminer|coche|archive|archiver|range|ranger|priorise|prioriser)\b/

/**
 * Désignation d'un ensemble sans le nommer : « décale mes tâches de vendredi »,
 * « repousse tout ce qui est en retard », « passe les p1 de cet aprem à demain ».
 */
const SCOPE = /\b(aujourd hui|demain|apres demain|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine|weekend|week end|mois|matin|midi|apres midi|aprem|soir|soiree|nuit|retard|overdue|tout|toutes|tous|chaque|reste|restantes|p1|p2|p3|p4|inbox|boite de reception)\b/

/** Références sans nom : « décale-la », « mets cette tâche demain ». */
const PRONOUNS = /\b(la|le|les|l|celle|celui|celles|ceux|ca|cela|cette tache|ce truc|celle ci|celle la)\b/

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Le nom de la tâche apparaît-il dans ce que l’utilisateur a écrit ? */
export function mentions(userText, taskName) {
  const haystack = normalize(userText)
  const needle = normalize(taskName)
  if (!haystack || !needle) return false
  if (haystack.includes(needle)) return true

  const tokens = needle.split(' ').filter((t) => t.length >= 4 && !STOPWORDS.has(t))
  if (!tokens.length) return false
  const hits = tokens.filter((t) => haystack.includes(t))
  // Un mot distinctif suffit quand il est long (« Tâche A », « Tâche E ») ;
  // sinon on exige la moitié des mots significatifs.
  if (hits.some((t) => t.length >= 6)) return true
  return hits.length / tokens.length >= 0.5
}

/**
 * @param {object} args
 * @param {string} args.toolName
 * @param {object} args.input          entrée de l'outil
 * @param {object} args.registry       TaskRegistry, pour retrouver les noms
 * @param {string[]} args.recentUserText  derniers messages de l’utilisateur, plus récent en premier
 * @param {boolean} args.createdThisTurn  une tâche a-t-elle été créée dans ce tour ?
 * @returns {{requested: boolean, reason?: string}}
 */
export function wasRequested({ toolName, input, registry, recentUserText = [], createdThisTurn = false }) {
  // Supprimer un projet, une section ou un libellé emporte tout ce qu'il contient :
  // ça se valide toujours.
  if (toolName === 'mcp__todoist__delete-object' && input?.type && input.type !== 'task') {
    return { requested: false, reason: 'suppression d\'un conteneur' }
  }
  // Une réorganisation en masse n'est jamais « juste ce qui a été demandé ».
  if (toolName === 'mcp__todoist__reorder-objects') {
    return { requested: false, reason: 'réorganisation en masse' }
  }

  const ids = affectedTaskIds(toolName, input)
  if (!ids.length) return { requested: false, reason: 'cible inconnue' }

  const text = recentUserText.filter(Boolean).join(' \n ')
  if (!text.trim()) return { requested: false, reason: 'aucune demande récente' }

  const names = ids.map((id) => registry?.taskName(id)).filter(Boolean)
  const named = names.filter((name) => mentions(text, name))
  if (names.length === ids.length && named.length === ids.length) {
    return { requested: true, reason: 'tâches nommées par l’utilisateur' }
  }
  // Il a nommé une tâche précise mais l'outil en touche d'autres : c'est justement
  // le débordement qu'il veut voir passer devant lui.
  if (named.length) {
    return { requested: false, reason: 'l\'action déborde des tâches nommées' }
  }

  const last = normalize(recentUserText[0] || '')
  const asked = ACTION_VERBS.test(last)

  // Les deux formes de demande sans nom de tâche. On les refuse quand le tour vient
  // de créer une tâche : c'est le moment où l'agent bouscule l'existant pour caser
  // la nouvelle, et c'est précisément ce qui doit se valider.
  if (asked && !createdThisTurn) {
    // « décale-la à demain »
    if (ids.length === 1 && PRONOUNS.test(last)) {
      return { requested: true, reason: 'reprise pronominale explicite' }
    }
    // « décale mes tâches de vendredi à lundi », « repousse tout ce qui est en retard »
    if (SCOPE.test(last)) {
      return { requested: true, reason: 'ensemble désigné par l’utilisateur' }
    }
  }

  return { requested: false, reason: 'cible non nommée par l’utilisateur' }
}

function affectedTaskIds(toolName, input) {
  if (!input || typeof input !== 'object') return []
  switch (toolName) {
    case 'mcp__todoist__reschedule-tasks':
    case 'mcp__todoist__update-tasks':
      return asArray(input.tasks).map((t) => t?.id).filter(Boolean)
    case 'mcp__todoist__complete-tasks':
    case 'mcp__todoist__uncomplete-tasks':
      return asArray(input.ids).filter(Boolean)
    case 'mcp__todoist__delete-object':
      return input.id ? [input.id] : []
    case 'mcp__todoist__project-move':
      return input.id ? [input.id] : []
    default:
      return []
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}
