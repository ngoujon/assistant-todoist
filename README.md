# Assistant Todoist

Une petite app macOS qui ouvre un assistant conversationnel — un agent Claude Code déguisé
en fenêtre mignonne — spécialisé dans la planification de tes tâches, branché sur ton
Todoist via MCP.

C'est exactement « Claude Code lancé dans un dossier hors projet », mais avec une interface
de chat au lieu du terminal : mêmes capacités (Bash, fichiers, web, réglages système),
plus les 47 outils Todoist.

## Utilisation

L'app est installée dans `/Applications/Assistant Todoist.app` et épinglée au Dock.
Un clic l'ouvre, la croix la masque (elle reste dans le Dock), `⌘Q` la quitte.

| Raccourci | Effet |
|---|---|
| `↩` | envoyer |
| `⇧↩` | nouvelle ligne |
| `esc` | refuser la carte en attente, sinon interrompre l'agent |
| `⌘.` | interrompre l'agent |
| `⌘N` | nouvelle conversation |

À l'ouverture, l'assistant **reprend la conversation précédente** : il se souvient de ce
que vous vous êtes dit ce matin. Le bouton `+` repart de zéro.

## Les règles de planification

L'assistant suit deux règles fortes, décrites dans `src/agent/prompt.mjs` **et** imposées
techniquement dans `src/agent/guards.mjs` (le prompt seul ne suffisait pas : le modèle
créait quand même la tâche en devinant).

**Règle n°1 — il tranche, il ne demande pas.** Priorité, durée, jour, heure, récurrence,
libellé : quand l'information manque, il choisit la valeur la plus raisonnable, l'applique
et **annonce son choix en gras** dans son résumé — tu corriges d'un mot si ça ne va pas.
Il ne pose une question que s'il est vraiment bloqué : cible ambiguë (« décale le
rendez-vous » alors qu'il y en a trois), ou fait qu'il ne peut pas inventer (une adresse,
un montant). Un hook `PreToolUse` **refuse** `add-tasks` tant qu'un de ces champs manque —
ou tant que les libellés du compte n'ont pas été lus — mais il demande à l'agent de
**combler lui-même** le trou, jamais de remonter la question.

**Règle n°2 — il a la main, y compris sur ce qu'il bouscule.** Libellé faux, priorité
incohérente, durée absurde, titre bancal, tâche à décaler pour caser la nouvelle : il
corrige, il déplace, et il le signale dans son résumé. Créneau plein ? Il ne s'arrête pas
pour demander quoi faire : il prend la meilleure décision, dit ce qui était là et ce que
son choix a coûté, et propose l'alternative en une ligne.

**Une seule carte de validation subsiste** : supprimer un projet, une section ou un
libellé entier, parce que ça emporte tout ce qu'il contient et que ça ne se rattrape pas.
Tout le reste part directement.

Décocher **Mode autonome** dans les réglages ⚙ ramène l'ancien comportement : toute action
qui **déplace ou supprime** (`reschedule`, `delete`, changement de projet ou de section,
réécriture d'une date existante) ouvre une carte. Un `update-tasks` qui ne touche qu'aux
libellés, à la priorité, à la durée ou au titre passe seul dans les deux modes — et dater
une tâche qui n'avait pas de date revient à la créer, donc pas de carte non plus.
`node scripts/permission-test.mjs` couvre les deux modes.

Autres garanties :

- **Priorités** : `p1` urgent · `p2` important · `p3` à faire · `p4` un jour. Todoist n'a
  que ces quatre niveaux (pas de `p0`, le maximum est `p1`).
- **Libellés** : il appelle `find-labels`, n'applique que des libellés **existants**, ignore
  les `ancien-*` et la coquille `coquille`, et n'en crée aucun — au pire il prend le plus proche
  et le signale. Le hook rejette tout libellé inconnu.
- **Récurrence** : appliquée en langage naturel si elle est précisée, choisie par lui si
  elle est vague. Le hook refuse `update-tasks` avec une date **sur une tâche récurrente**
  (ça écraserait la récurrence) et renvoie vers `reschedule-tasks`.
- **Dates** : `reschedule-tasks` déplace une tâche déjà datée ; `update-tasks` avec
  `dueString` est le seul moyen de dater une tâche qui n'en a pas.
- **Tâches sans date** : une tâche `p4` — ou demandée « sans date », « backlog », « un
  jour » — se crée sans échéance ; le hook ne l'exige que pour le reste.

## Les cartes de validation

**Un déplacement se dessine.** La carte montre la journée touchée *avant* et *après*, à
l'échelle : ce qui reste en place, ce qui part (en pointillé), ce qui arrive (en corail),
et les blocs qui se chevauchent — côte à côte, cerclés de rouge, avec la ligne
« Chevauchement : X × Y ». `src/agent/impact.mjs` calcule le modèle à partir des tâches
que l'agent a déjà lues, `src/renderer/impact.js` le dessine.

Sous le schéma, la phrase en clair — nom de la tâche, ancienne date → nouvelle date,
champs modifiés — et non le JSON de l'outil (`src/agent/summary.mjs` traduit, avec
`registry.mjs` qui résout les identifiants). Le détail technique reste à un clic.

L'app signale aussi une limite d'usage Claude atteinte ou proche : sans ça, une réponse
qui n'arrive jamais ressemble à un bug.

Au clavier, quand une carte attend : **`↩` autorise**, **`esc` refuse**. `↩` n'autorise que
si le champ de saisie est vide — sinon la phrase en cours part comme message, elle ne
valide rien par accident.

## Écrire pendant qu'il travaille

Le champ de saisie n'est jamais bloqué. Un message envoyé pendant un traitement est
**fondu dans le tour en cours** par le CLI : l'agent le lit en route, relance les outils
qu'il faut et répond aux deux demandes d'un coup (vérifié : « compte mes projets » puis,
5 s plus tard, « et aussi les libellés » → une seule réponse couvrant les deux). La bulle
porte alors la mention *ajouté au traitement en cours*.

Le bouton reste **envoyer** tant qu'il y a du texte ; il ne devient **arrêter** que si le
champ est vide (sinon `esc` ou `⌘.`). Écrire alors qu'une carte de validation attend vaut
refus de cette carte — sinon le message resterait sans effet, l'agent étant bloqué sur son
outil.

## Ce qu'il fait sans demander

- **Mode autonome (par défaut)** : tout Todoist part seul — lire, créer, dater, décaler,
  reprioriser, terminer, supprimer une tâche. Seule la suppression d'un projet, d'une
  section ou d'un libellé ouvre une carte.
- **Toujours confirmés** : `Bash`, l'écriture de fichiers, les réglages système.
- **Mode autonome décoché** : tout déplacement ou suppression Todoist repasse par une carte.

## Architecture

```
src/main.mjs           processus principal Electron : fenêtre, IPC, permissions, config
src/preload.cjs        pont contextIsolation (aucun accès Node côté page)
src/agent/session.mjs  session Claude Agent SDK : options, routage des messages, permissions
src/agent/prompt.mjs   personnalité et règles métier (PROMPT_VERSION à incrémenter si elles changent)
src/agent/guards.mjs   hooks PreToolUse : refusent l'outil tant qu'il manque une info
src/agent/registry.mjs mémoire id -> nom des objets Todoist croisés
src/agent/summary.mjs  traduction d'une demande d'autorisation en français lisible
src/agent/impact.mjs   modèle avant/après d'un déplacement, avec chevauchements
src/renderer/          interface : chat, markdown maison, cartes d'outils, schéma d'impact
scripts/               icône, build, installation, prévisualisation, test d'intégration
```

Points clés :

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) en mode *streaming input* :
  une seule session `query()` vit pendant toute la conversation, alimentée par une file
  d'attente asynchrone. Pas de clé API : l'authentification Claude Code existante est
  réutilisée, et le binaire Claude Code est embarqué dans le bundle.
- **MCP Todoist** déclaré explicitement (`strictMcpConfig`) pour n'exposer que Todoist,
  sans les autres serveurs MCP configurés sur la machine.
- **Permissions** : `canUseTool` renvoie une promesse résolue par l'interface ; les
  outils sûrs sont filtrés avant même d'arriver à l'utilisateur.
- L'espace de travail de l'agent est
  `~/Library/Application Support/Assistant Todoist/Espace de travail`
  (accessible depuis les réglages).

## Développement

```bash
npm start                     # lance l'app depuis les sources
npm run icon                  # régénère assets/icon.icns (rendu CoreGraphics)
npm run build                 # produit build/Assistant Todoist.app (signature ad-hoc)
npm run install-app           # copie dans /Applications + épingle au Dock

node scripts/selftest.mjs     # test d'intégration : vraie session agent + Todoist
node scripts/impact-test.mjs  # modèle avant/après d'un déplacement
node scripts/permission-test.mjs  # ce qui ouvre une carte, ce qui passe seul
npx electron scripts/preview.mjs sortie.png   # capture l'UI avec une conversation factice
THEME=dark npx electron scripts/preview.mjs   # idem en thème sombre
```

Après modification du bundle, la signature ad-hoc (`codesign --sign -`) est obligatoire
sur Apple Silicon : `scripts/build-app.sh` s'en charge.

## Pièges rencontrés (à ne pas réintroduire)

- **Pas d'asar** : le binaire Claude Code embarqué ne peut pas être lancé depuis
  `app.asar` (`spawn ENOTDIR`). Le build utilise `--no-asar`.
- Le `cwd` passé au SDK **doit exister**, sinon l'erreur remontée parle à tort d'un
  binaire incompatible.
- Une app lancée depuis le Dock n'hérite pas du `PATH` du shell : il est reconstruit
  dans `session.mjs` pour que `Bash` trouve Homebrew et consorts.
- Les événements de l'agent émis avant le chargement du renderer sont mis en tampon,
  sinon l'état « Todoist connecté » se perd au démarrage.
- `scripts/install-app.sh` **reconstruit systématiquement** : réutiliser un `build/`
  existant installait silencieusement une version périmée.
- Un changement de règles métier doit s'accompagner d'un `PROMPT_VERSION` incrémenté,
  sinon la conversation reprise garde l'ancien comportement par mimétisme.
- Le CLI n'émet `system/init` qu'après avoir reçu un premier message : l'en-tête affiche
  donc « Prêt », puis « Todoist connecté » dès la première question. **Ne pas** tenter de
  forcer l'init avec un message `shouldQuery: false` : il fusionne avec le suivant et
  **avale le premier vrai message** (reproduit puis retiré).
- L'occupation de l'agent ne peut pas se compter en envois : deux messages peuvent être
  fondus dans un seul tour, donc un seul `result`. Elle suit son activité réelle.
- `init` peut arriver plusieurs fois dans une session — dédupliquer les notes qui en dépendent.
- Faire valider les décisions de l'agent (métadonnées devinées, tâche bousculée) coûtait
  un aller-retour au clavier à chaque demande : mieux vaut qu'il tranche, qu'il l'annonce,
  et qu'on corrige après coup. Seul l'irrattrapable — un conteneur supprimé — se valide.
- La mémoire des tâches (`taches-connues.json` dans le dossier de l'app) doit survivre au
  redémarrage : sans elle, une conversation reprise affiche « une tâche non identifiée »
  dans les validations et le schéma d'impact ne peut pas se dessiner.
- `reschedule-tasks` **exige une date existante** : un garde-fou qui renvoie systématiquement
  `update-tasks` vers lui enferme l'agent dans un cul-de-sac sur une tâche non datée — les
  deux chemins se ferment et la tâche ne peut plus être datée du tout.
- Un garde-fou qui exige une date à la création rend impossible la tâche de réservoir,
  et l'agent boucle : il redemande le jour, on répond « pas de date », il est rebloqué.
- Ne pas mettre d'accélérateur `Esc` sur un élément de menu : il capterait la touche avant
  l'interface, qui en a besoin pour refuser une validation.
