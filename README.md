# Assistant Todoist

Une petite app macOS qui ouvre un assistant conversationnel — un agent déguisé en fenêtre
mignonne — spécialisé dans la planification de tes tâches, branché sur ton Todoist via MCP.

**L'IA tourne en local.** Le moteur d'inférence est un LM Studio sur le réseau
(`http://localhost:1234` par défaut, réglable) : aucune requête ne part chez Anthropic,
et l'app ne demande aucun compte Claude. Seul Todoist reste un service distant — c'est là
que vivent les tâches, il n'y a pas d'alternative hors ligne.

Le harnais reste celui de Claude Code, lancé comme binaire local : mêmes capacités (Bash,
fichiers, web, réglages système), plus les 47 outils Todoist.

## Utilisation

L'app est installée dans `/Applications/Assistant Todoist.app` et épinglée au Dock.
Un clic l'ouvre, la croix la masque (elle reste dans le Dock), `⌘Q` la quitte.

| Raccourci | Effet |
|---|---|
| `↩` | envoyer |
| `⇧↩` | nouvelle ligne |
| `esc` | interrompre l'agent |
| `⌘.` | interrompre l'agent |
| `⌘N` | nouvelle conversation |

À l'ouverture, l'assistant **reprend la conversation précédente** : il se souvient de ce
que vous vous êtes dit ce matin. Le bouton `+` repart de zéro.

## Les règles de planification

L'assistant suit trois règles fortes, décrites dans `src/agent/prompt.mjs` **et** imposées
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

**Règle n°3 — plus aucune validation, mais un récap annulable.** Rien n'est soumis avant :
l'agent exécute, y compris les suppressions, y compris quand deux tâches se retrouvent à la
même heure. En fin de tour, l'app affiche un **récap de tout ce qui a bougé** avec un bouton
**Annuler** qui rejoue les actions à l'envers. Le contrôle est passé d'« avant, à chaque
action » à « après, sur l'ensemble du tour ».
`node scripts/undo-test.mjs` vérifie ce qui s'annule et ce qui ne s'annule pas.

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

## Le récap et son « Annuler »

Une carte par tour, en fin de traitement : une ligne par action, en français
(`src/agent/summary.mjs` traduit, `registry.mjs` résout les identifiants), et le bouton
**Annuler**.

**Un déplacement se dessine.** Le récap montre la journée touchée *avant* et *après*, à
l'échelle : ce qui reste en place, ce qui part (en pointillé), ce qui arrive (en corail),
et les blocs qui se chevauchent — côte à côte, cerclés de rouge, avec la ligne
« Chevauchement : X × Y ». `src/agent/impact.mjs` calcule le modèle à partir des tâches
que l'agent a déjà lues, `src/renderer/impact.js` le dessine.

**Comment l'annulation marche.** `src/agent/journal.mjs` note chaque écriture *au moment de
l'appel* — le dernier instant où `registry.mjs` tient encore l'état d'avant — et en déduit
l'appel inverse : une création se supprime, un déplacement se repose sur sa date d'origine,
une métadonnée se réécrit à son ancienne valeur, une récurrente retrouve sa formulation
(`tous les mardis à 10h`), une tâche supprimée se recrée. Le clic envoie à l'agent la liste
exacte de ces appels, dans l'ordre inverse, avec les garde-fous mis en veille — ils
empêchent d'écrire n'importe quoi, pas de remettre ce qui était là.

**Ce qui ne s'annule pas est dit comme tel**, en étiquette sur la ligne concernée :
suppression d'un projet, d'une section ou d'un libellé (ça emporte leur contenu), tout ce
qui se passe hors de Todoist (`Bash`, écriture de fichiers, réglages système), un
réordonnancement de masse, et toute action dont l'état d'avant n'était pas connu. Le bouton
devient alors « Annuler ce qui peut l'être (n/m) ».

L'app traduit aussi les pannes du serveur local : contexte trop court, modèle non chargé,
serveur injoignable. Sans ça, une réponse qui n'arrive jamais ressemble à un bug.

## Écrire pendant qu'il travaille

Le champ de saisie n'est jamais bloqué. Un message envoyé pendant un traitement est
**fondu dans le tour en cours** par le CLI : l'agent le lit en route, relance les outils
qu'il faut et répond aux deux demandes d'un coup (vérifié : « compte mes projets » puis,
5 s plus tard, « et aussi les libellés » → une seule réponse couvrant les deux). La bulle
porte alors la mention *ajouté au traitement en cours*.

Le bouton reste **envoyer** tant qu'il y a du texte ; il ne devient **arrêter** que si le
champ est vide (sinon `esc` ou `⌘.`).

## Ce qu'il fait sans demander

**Tout.** Lire, créer, dater, décaler, reprioriser, terminer, supprimer — et aussi `Bash`,
l'écriture de fichiers, les réglages système. `canUseTool` répond `allow` sans condition.
Le seul point de contrôle est le récap, après coup. Une action interrompue en plein vol est
signalée « issue inconnue » plutôt que rangée d'office parmi les réussites.

## Architecture

```
src/main.mjs           processus principal Electron : fenêtre, IPC, config
src/preload.cjs        pont contextIsolation (aucun accès Node côté page)
src/agent/session.mjs  session Claude Agent SDK : options, routage des messages, annulation
src/agent/prompt.mjs   personnalité et règles métier (PROMPT_VERSION à incrémenter si elles changent)
src/agent/guards.mjs   hooks PreToolUse : refusent l'outil tant qu'il manque une info
src/agent/registry.mjs mémoire des objets Todoist croisés : noms, et état d'avant
src/agent/journal.mjs  ce qui a été fait dans le tour, et l'appel inverse de chaque action
src/agent/summary.mjs  traduction d'une action exécutée en français lisible
src/agent/impact.mjs   modèle avant/après d'un déplacement, avec chevauchements
src/agent/local-model.mjs  pont vers le serveur d'IA local : compatibilité et erreurs lisibles
src/renderer/          interface : chat, markdown maison, cartes d'outils, récap, schéma d'impact
scripts/               icône, build, installation, prévisualisation, test d'intégration
```

Points clés :

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) en mode *streaming input* :
  une seule session `query()` vit pendant toute la conversation, alimentée par une file
  d'attente asynchrone. Le binaire est embarqué dans le bundle et tourne en local.
- **Inférence locale** : `ANTHROPIC_BASE_URL` pointe sur un pont interne
  (`src/agent/local-model.mjs`) qui relaie vers LM Studio. Aucune clé API, aucun compte
  Claude, et la télémétrie du CLI est coupée (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`).
- **MCP Todoist** déclaré explicitement (`strictMcpConfig`) pour n'exposer que Todoist,
  sans les autres serveurs MCP configurés sur la machine.
- **Aucune permission** : `canUseTool` autorise tout. Le contrôle est déplacé en aval, dans
  `journal.mjs`, qui capture l'état d'avant à chaque appel et sait le rétablir.
- L'espace de travail de l'agent est
  `~/Library/Application Support/Assistant Todoist/Espace de travail`
  (accessible depuis les réglages).

## Le serveur d'IA local

LM Studio expose l'**API Messages d'Anthropic** sur `/v1/messages` — pas seulement l'API
OpenAI — streaming SSE et blocs `tool_use` compris. C'est ce qui permet de garder le
harnais Claude Code tel quel : il suffit de le faire pointer ailleurs.

Deux écarts subsistent, traités par `src/agent/local-model.mjs` :

- **Consignes système en cours de conversation.** Le CLI insère des messages
  `role: "system"` au fil de l'échange ; le gabarit de chat de Qwen les refuse
  (`System message must be at the beginning`). Le pont les replie en messages
  utilisateur préfixés `[consigne système]`.
- **Erreurs illisibles.** Le moteur renvoie du JSON imbriqué sur trois niveaux. Le pont
  en extrait une phrase actionnable, affichée dans la conversation.

**Contexte requis.** Le socle du CLI pèse ~17 800 tokens à vide, et ~34 300 une fois les
47 outils Todoist déclarés — avant la moindre question. Charge le modèle avec **65 536
tokens de contexte au minimum** dans LM Studio (réglage *Context Length* au chargement,
ou `lms load --context-length 65536`) ; en dessous, chaque requête échoue. Ce réglage
n'est pas pilotable à distance : LM Studio n'expose pas d'endpoint de chargement.

Le modèle et l'adresse du serveur se changent dans les réglages ⚙ ; la liste déroulante
est peuplée par ce que `/v1/models` annonce réellement.

## Développement

```bash
npm start                     # lance l'app depuis les sources
npm run icon                  # régénère assets/icon.icns (rendu CoreGraphics)
npm run build                 # produit build/Assistant Todoist.app (signature ad-hoc)
npm run install-app           # copie dans /Applications + épingle au Dock

node scripts/selftest.mjs     # test d'intégration : vraie session agent + Todoist
node scripts/impact-test.mjs  # modèle avant/après d'un déplacement
node scripts/undo-test.mjs        # ce qui s'annule, ce qui ne se rattrape pas
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
- Faire valider les décisions de l'agent coûtait un aller-retour au clavier à chaque
  demande. Le contrôle est passé **après** l'exécution : il tranche, il fait, l'app
  récapitule et sait défaire. Une carte qui arrive quand tout est déjà fait se lit en
  diagonale ; une carte qui bloque l'agent, non.
- Une annulation ne peut pas se déduire de l'appel seul : il faut l'état **d'avant**,
  capturé au moment de l'appel — le résultat de l'outil écrase ensuite la mémoire.
- L'inverse d'une récurrente n'est pas une date mais sa **formulation** (`tous les lundis
  à 9h`) : reposer une date la transformerait en tâche ponctuelle.
- Les garde-fous doivent se mettre en veille pendant une annulation : ils refusent d'écrire
  une valeur incomplète, or rétablir l'existant, c'est parfois réécrire exactement ça.
- La mémoire des tâches (`taches-connues.json` dans le dossier de l'app) doit survivre au
  redémarrage : sans elle, une conversation reprise affiche « une tâche non identifiée »
  dans le récap, le schéma d'impact ne peut pas se dessiner et plus rien n'est annulable.
- `reschedule-tasks` **exige une date existante** : un garde-fou qui renvoie systématiquement
  `update-tasks` vers lui enferme l'agent dans un cul-de-sac sur une tâche non datée — les
  deux chemins se ferment et la tâche ne peut plus être datée du tout.
- Un garde-fou qui exige une date à la création rend impossible la tâche de réservoir,
  et l'agent boucle : il redemande le jour, on répond « pas de date », il est rebloqué.
- Ne pas mettre d'accélérateur `Esc` sur un élément de menu : il capterait la touche avant
  l'interface, qui en a besoin pour interrompre l'agent.
