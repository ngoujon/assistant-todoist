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

**Règle n°1 — dans le doute, il demande.** Il ne devine jamais la *priorité*, la *durée*,
le *jour* ni la *récurrence*. Il pose toutes ses questions dans un seul message numéroté,
avec sa suggestion par défaut, puis attend. Un hook `PreToolUse` **refuse** `add-tasks`
tant qu'il manque l'un de ces champs — ou tant que les libellés du compte n'ont pas été lus.

**Règle n°2 — ce qu'il bouscule se valide.** Ce que tu demandes, il le fait : tu n'as pas
à revalider ta propre consigne (« décale Tâche A à lundi 9h30 » → il décale, il confirme).
La carte de validation ne sort que pour ce que tu **n'as pas** demandé : la tâche déplacée
d'autorité pour en caser une autre, la priorité changée au passage, le ménage proposé.
Il expose alors le conflit, propose les options (*en parallèle ?* / *je décale telle tâche
à tel jour ?*) et attend le feu vert.

`src/agent/intent.mjs` fait ce tri : il compare les tâches visées par l'outil aux noms que
tu viens d'employer (accents et casse ignorés, un mot distinctif suffit), gère la reprise
pronominale (« décale-la à demain ») et la désactive quand le tour vient de créer une
tâche — précisément le cas où l'agent bouscule l'existant pour caser la nouvelle. Restent
toujours confirmées : la suppression d'un projet, d'une section ou d'un libellé, et les
réorganisations en masse. `node scripts/intent-test.mjs` couvre ces cas.

Autres garanties :

- **Priorités** : `p1` urgent · `p2` important · `p3` à faire · `p4` un jour. Todoist n'a
  que ces quatre niveaux (pas de `p0`, le maximum est `p1`).
- **Libellés** : il appelle `find-labels`, n'applique que des libellés **existants**, ignore
  les `ancien-*` et la coquille `coquille`, et ne crée jamais un libellé sans accord. Le hook
  rejette tout libellé inconnu.
- **Récurrence** : appliquée en langage naturel si elle est précisée, demandée si elle est
  ambiguë. `update-tasks` portant une date est refusé par le hook — il détruirait la
  récurrence, `reschedule-tasks` est le bon outil.

## Les cartes de validation

Elles disent en clair ce qui va se passer — nom de la tâche, ancienne date → nouvelle date,
champs modifiés — et non le JSON de l'outil (`src/agent/summary.mjs` traduit, avec
`registry.mjs` qui garde en mémoire les tâches croisées pour résoudre les identifiants).
Le détail technique reste accessible d'un clic.

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

- **Sans confirmation** : toute lecture (Todoist, fichiers, web) et — par défaut — la
  création et la complétion de tâches. Décochable dans les réglages ⚙.
- **Avec confirmation** : tout déplacement Todoist, `Bash`, l'écriture de fichiers, le
  système.

## Architecture

```
src/main.mjs           processus principal Electron : fenêtre, IPC, permissions, config
src/preload.cjs        pont contextIsolation (aucun accès Node côté page)
src/agent/session.mjs  session Claude Agent SDK : options, routage des messages, permissions
src/agent/prompt.mjs   personnalité et règles métier (PROMPT_VERSION à incrémenter si elles changent)
src/agent/guards.mjs   hooks PreToolUse : refusent l'outil tant qu'il manque une info
src/agent/registry.mjs mémoire id -> nom des objets Todoist croisés
src/agent/summary.mjs  traduction d'une demande d'autorisation en français lisible
src/renderer/          interface : chat, markdown maison, cartes d'outils et de permission
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
- Ne pas mettre d'accélérateur `Esc` sur un élément de menu : il capterait la touche avant
  l'interface, qui en a besoin pour refuser une validation.
