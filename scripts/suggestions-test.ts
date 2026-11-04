// Les boutons de l'accueil comptent les genres de demandes, pas les phrases exactes.
import { frequentSuggestions } from '../src/suggestions.ts'

const history = [
  'met une tâche demain 10h tâche A',
  'ajoute une tache lundi pour tâche B',
  'déplace la tâche C à samedi',
  'deplace tâche D à lundi',
  'mets un rappel vendredi pour tâche E',
  'Qu\'est-ce que je fais aujourd\'hui ?',
  'qu\'est-ce que je fais aujourd\'hui ?',
  'repousse tâche F à demain',
]

const got = frequentSuggestions(history)
let ko = 0
const check = (label: string, ok: boolean) => {
  if (!ok) ko++
  console.log(`${ok ? 'ok  ' : 'ECHEC'} ${label}`)
}

check('phrase répétée en premier, envoyée telle quelle', got[0]?.send === true && got[0]?.count === 2)
check('déplacer devant ajouter (3 contre 2)', got[1]?.label.includes('Déplacer') === true && got[1]?.count === 3)
check('ajouter ensuite, préremplit le champ', got[2]?.label.includes('Ajouter') === true && got[2]?.send === false)
check('quatre boutons au plus', got.length <= 4)
check('historique vide : aucun bouton', frequentSuggestions([]).length === 0)

console.log(ko ? `\n${ko} cas en échec` : '\nTous les cas passent')
if (ko) process.exit(1)
