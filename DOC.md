# Suivi Bébé — Documentation technique (rétro-doc)

Application web mobile (PWA) de **suivi quotidien d'un nourrisson** : tétées, biberons,
couches, sommeil, soins, température, médicaments, et journal « ce que bébé a appris ».
Pensée pour être partagée entre **deux téléphones** (les deux parents) avec synchro
temps réel, tout en restant **utilisable hors-ligne**.

> Contexte de fiabilité codé en dur : bébé né le **6 août 2026 à 5h25**. Les dates de
> début de fiabilité des données (`DATA_START`, `FIRST_COMPLETE_DAY`) référencent ces
> repères.

---

## 1. En un coup d'œil

| Aspect | Choix |
|---|---|
| Stack | HTML + CSS + JS **vanilla**, **aucun build**, aucun framework |
| Hébergement | 100 % statique (GitHub Pages) |
| Installation | **PWA** installable, plein écran, hors-ligne (service worker) |
| Stockage local | `localStorage` (offline-first, rendu instantané) |
| Synchro | **Supabase** (Postgres + Auth + Realtime), optionnelle |
| Langue / cible | Français, **mobile-first** (max 560 px, safe-areas iOS) |
| Modèle de données | **Un seul journal d'événements** `{ id, action, data, ts, deleted }` |
| Vues | Suivi · Appris · Stats · **Prédiction** (expérimentale, conditionnelle) |
| Tests | `node tests/run.js` — sans dépendance, **103 cas**, TZ forcé (§12) |

Principe fondateur : **une seule source de vérité, le journal d'événements brut**.
Aucune statistique n'est stockée — tout est **recalculé à la volée**. Corriger un
événement corrige automatiquement toutes les vues et stats (pas de dérive). Cela vaut
aussi pour le prédictif et son laboratoire : **rien n'est mis en cache, rien n'est
persisté** (§8.8).

Corollaire de méthode, visible partout dans le code : **on n'invente jamais une donnée**.
Un champ absent reste absent (`null`), il ne devient pas un zéro ; une anomalie est
signalée plutôt que corrigée en silence ; un modèle qui ne sait pas répondre renvoie
`null`. Les règles de précision qui en découlent sont listées en §7, et les garde-fous
qui les verrouillent en §12.

---

## 2. Structure des fichiers

```
Suivi bébé/
├── index.html            # Coquille de l'app : 4 vues, sheet, confirmation, verrou, toast
├── app.js                # Toute la logique UI + couche Store (localStorage + Supabase)
├── stats.js              # Couche de calcul PURE (event[] → KPI, prédictif, labo)
├── styles.css            # Thème, tuiles, sheet, graphes, frise, labo, verrouillage
├── config.js             # Config Supabase (url / anon / email foyer) — NON versionné (.gitignore)
├── sw.js                 # Service worker PWA (cache offline, versionné)
├── manifest.webmanifest  # Manifeste PWA (nom, icônes, standalone, portrait)
├── vendor/supabase.js    # Client Supabase embarqué (pas de CDN → offline)
├── icons/                # Icônes PWA (192, 512, apple-touch)
├── tools/gen_icons.py    # Génération des icônes (cœur blanc sur dégradé rose→bleu)
├── tests/                # Suite de tests sans dépendance → `node tests/run.js` (§12)
│   ├── run.js            #   harnais + point d'entrée (force TZ=Europe/Paris)
│   ├── stats.test.js     #   règles de calcul (§7)
│   ├── prediction.test.js#   prédictif : échantillons, backtests, états (§8)
│   ├── lab.test.js       #   laboratoire Champion/Challengers (§8)
│   └── guards.test.js    #   gardes au niveau des sources
├── DOC.md                # Ce document (rétro-doc)
├── SPECS-stats.md        # Spécification détaillée du reporting / KPI (fait foi pour §7)
├── SPECS-timeline.md     # Spécification de la vue Frise du journal
├── RECOS-prediction-sommeil-v5.md  # Spécification du prédictif + du laboratoire (fait foi pour §8)
├── mockup-prediction.html          # Maquette de référence de l'onglet Prédiction
└── README.md             # Notes de lancement
```

**Versionnage des assets** : les URL portent `?v=N` (aujourd'hui `styles.css?v=33`,
`app.js?v=33`, `stats.js?v=31`, `config.js?v=15`) et le cache du service worker
(`CACHE = 'suivi-bebe-v33'`) est aligné sur le **plus grand** de ces numéros.
Toute mise à jour d'asset doit **incrémenter `N` dans `index.html` et reporter la même
URL dans `ASSETS` de `sw.js`**, sinon les clients installés gardent l'ancienne version.
Les trois invariants (`CACHE` = max des `?v=N`, `ASSETS` ⊇ URLs d'`index.html`, et
réciproquement aucune URL périmée) sont **vérifiés par un test** (§12) — un oubli fait
échouer `node tests/run.js`.

---

## 3. Modèle de données

Un événement unique décrit toute activité :

```js
{
  id: "uuid",          // crypto.randomUUID()
  action: "tetee",     // type d'événement (voir table ci-dessous)
  data: { … },         // charge utile spécifique au type
  ts: "ISO-8601",      // horodatage de l'événement (éditable)
  deleted: false       // soft-delete (tombstone) → se propage à l'autre appareil
}
```

### Types d'actions (`ACTIONS` dans app.js)

| action | `place` | `data` | Notes |
|---|---|---|---|
| `tetee` | tile | `side?` ∈ {gauche, droite, les deux}, `duration?` (min) | les 2 champs optionnels |
| `biberon` | tile | `ml` (nombre, défaut 90) | volume bu |
| `couche` | tile | `type?` ∈ {pipi, caca, mixte} | `mixte` = pipi **et** caca |
| `sommeil` | tile | `end` (ISO \| null) | `ts` = coucher, `end` = réveil, `null` = en cours |
| `bain` | tile | `{}` | horodatage seul |
| `temperature` | tile | `temp` (°C, 1 déc.) | alerte ≥ 38,0 °C |
| `medicament` | tile | `name?` | nom optionnel |
| `vitamined` | checklist | `{}` | case à cocher quotidienne |
| `ventre` | checklist | `{}` | temps sur le ventre |
| `yeux` / `nez` | checklist | `{}` | soins quotidiens |
| `appris` | (ni tile ni checklist) | `text` | journal des nouveautés, hors stats |

> Le soin du **cordon** a existé dans la checklist puis a été retiré (cordon tombé) :
> `ACTIONS` ne le contient plus. D'anciens événements `cordon` peuvent subsister dans le
> journal — un type inconnu n'est jamais une erreur d'affichage : dans la liste il tombe
> sur le repli `ACTION_MAP[ev.action] || { name: ev.action, emoji: '•' }` (app.js:709),
> et dans la frise il est simplement ignoré (aucune voie ne le réclame).

Ajouter un type = ajouter une entrée à `ACTIONS` (+ éventuellement un module de champs
`FORMS[id]` et une couleur `--c-*`). Le reste de l'UI (grille, journal, checklist) se
génère automatiquement.

---

## 4. Couche de données `Store` (app.js)

Objet unique qui **encapsule tout l'accès aux données**. L'UI ne parle qu'à lui via une
API publique stable, quel que soit l'état de la synchro.

### API publique (consommée par l'UI)

| Méthode | Rôle |
|---|---|
| `all()` | événements non supprimés, triés du + récent au + ancien |
| `byDay(date)` | événements d'un jour civil |
| `byAction(action)` | événements d'un type |
| `range(from, to)` | événements entre deux dates (dashboard/heatmap) |
| `lastOf(action)` | dernier événement d'un type (bandeau « dernière fois ») |
| `add(action, data, ts)` | crée un événement |
| `update(id, patch)` | remplace des champs de l'événement |
| `patchData(id, dataPatch)` | fusionne des clés dans `data` |
| `remove(id)` | **soft-delete** (`deleted:true`, tombstone) |
| `exportJSON()` | dump JSON de tous les événements |
| `refresh()` | re-fusion serveur + flush (pull-to-refresh / retour au 1er plan) |
| `subscribe(cb)` | s'abonner aux changements (déclenche un re-render) |

### Cache mémoire

- `_cache` : tableau de **toutes** les lignes (deleted inclus)
- `_byId` : `Map(id → ligne)` (mêmes références que `_cache`)
- Lecture paresseuse via `_load()`, ré-indexation via `_reindex()`.
- `_save()` persiste dans `localStorage` et notifie les abonnés ; en cas d'échec
  (stockage plein / navigation privée) → toast d'avertissement, pas de crash.

### Clés localStorage

| Clé | Contenu |
|---|---|
| `suivi-bebe-events` | le journal complet |
| `suivi-bebe-queue` | file d'envoi vers le serveur (persistée pour survivre au hors-ligne) |
| `suivi-bebe-migrated` | drapeau « migration locale → serveur déjà faite » |
| `suivi-bebe-journal-view` | préférence de vue du journal : `list` (défaut) ou `timeline` |

C'est **toute** la liste : ni les statistiques, ni le prédictif, ni le laboratoire
n'écrivent quoi que ce soit (§8.8) — tout est recalculé depuis le journal.

---

## 5. Synchro Supabase (offline-first)

La synchro est **optionnelle et non bloquante** : tant que `config.js` n'est pas
renseigné (ou contient `XXXX`), l'app tourne **100 % en local**.

### Architecture

```
Écriture UI ──► Store.add/update/remove ──► localStorage (source locale)
                                        └─► _queue (Map id→snapshot) ──► _flush() ──► upsert Supabase
                                                                                          │
Realtime (postgres_changes) ◄── serveur estampe updated_at (trigger) ◄────────────────────┘
        │
        └─► _applyRealtime() fusionne dans le cache local
```

- **File d'envoi** (`_queue`) : chaque écriture est mise en file (coalescée par `id`),
  persistée, puis « flushée » en `upsert` (`onConflict: 'id'`). Si hors-ligne, la file
  survit et est rejouée au retour (`online`, visibilité, refresh).
- **Realtime** : canal `events-sync` sur la table `events` ; les échos de nos propres
  écritures (présentes en file, ou identiques à la version locale) sont ignorés.
- **Pull** (`_pullAll`) : récupère l'état serveur et le fusionne.
- **Migration unique** (`_migrateOnce`) : à la 1re connexion, enfile tout l'existant
  local vers le serveur (une seule fois, gardée par `suivi-bebe-migrated`).

### Règle de résolution de conflit

> Une écriture **encore en file locale** l'emporte (on ignore la version serveur pour
> cet `id`). Sinon, le **serveur est autoritaire** (on adopte sa version).
> La suppression est un **soft-delete** qui se propage comme un événement normal.

### Authentification

Compte **« foyer » partagé** (`config.js` : `email` fixe). La vraie barrière est le
**mot de passe = « code partagé »** saisi à l'écran de verrouillage, jamais stocké.
`url` et `anon` sont publics (protégés par la RLS Supabase côté serveur).

### États de synchro (pastille en bas d'écran)

| État | Pastille | Signification |
|---|---|---|
| `local` | (masquée) | synchro non configurée → app 100 % locale |
| `ok` | ● vert | synchronisé |
| `pending` | ◍ | envoi en cours |
| `offline` | ○ | hors-ligne — tap pour se reconnecter |

### Séquence de démarrage (fin de app.js)

1. Rendu **immédiat** depuis le cache local (offline-first).
2. `initSupabase()` : si non configuré → `local`, fin.
3. `restoreSession()` : session valide → pull + realtime, fin.
4. Sinon : s'il y a déjà des données locales → `offline` (non bloquant) ;
   au **vrai premier lancement** (aucune donnée) → écran de verrouillage bloquant.

---

## 6. Interface (app.js + index.html)

Quatre vues, une **barre d'onglets** (`VIEWS`, app.js:327) :
**Suivi 📋 · Appris ✨ · Stats 📊 · Prédiction 🔮**.

Le dernier onglet est **conditionnel** : `when: () => Stats.hasSleepSamples(…)` — il
n'apparaît qu'à partir du moment où **au moins un** des deux prédicteurs a un point de
donnée. Inutile d'exposer un laboratoire vide ; c'est aussi le mécanisme prévu pour
brancher d'autres vues plus tard (une entrée `VIEWS` + un `<div class="view">`).

### Vue Suivi (écran principal)

- **Barre de date** : navigation jour précédent/suivant (pas de futur). Un jour ≠
  aujourd'hui grise légèrement le fond (`body.other-day`).
- **Bandeau « dernière fois »** (`status-strip`) : pour tétée/biberon/couche/sommeil,
  temps écoulé depuis la dernière fois (ou chrono du dodo en cours).
- **Checklist quotidienne** : gestes systématiques (vitamine D, ventre, yeux, nez).
  1 tap = fait (avec l'heure) ; re-tap = édition.
- **Grille de tuiles** : gros boutons ouvrant un **bottom sheet** de saisie. Chaque
  tuile affiche un **badge compteur du jour** (`tileStat`) : nb + durée/volume/💧💩.
- **« Ce que j'ai appris »** : ajout rapide d'une nouveauté du jour.
- **Journal du jour** : **deux vues au choix**, bascule `Liste / Frise` (`#journalSeg`),
  préférence retenue dans `localStorage['suivi-bebe-journal-view']`.

#### Journal — vue Liste (`renderJournalList`)

Liste chronologique **éditable** des événements du jour (hors « appris ») : emoji,
libellé, `describe(ev)`, heure. Un tap ouvre la feuille d'édition.

#### Journal — vue Frise (`renderJournalTimeline`, spec `SPECS-timeline.md`)

Représentation **temporelle** du jour, en **lecture seule** :

- **2 bandes de 12 h** (`JOURNAL_BANDS` : 0→12 h, 12→24 h) plutôt qu'un axe de 24 h
  écrasé sur 360 px de large ; graduations toutes les **2 h**.
- **3 pistes** (`JOURNAL_LANES`) : `repas` (tétée + biberon), `sommeil`, `couche`.
  Les soins (bain, température, médicament) **n'ont pas de piste** — ils sont
  ponctuels et rares : la vue Liste les montre mieux.
- **Sommeil = barre**, bornée au jour affiché via le segment `_seg` **calculé par
  `Stats.sleepSegments`** (jamais recalculé ici, cf. la garde de test §12) : une nuit
  à cheval sur minuit est tronquée à 0 h / 24 h avec un marqueur de continuité
  (`cont-prev` / `cont-next`) ; un dodo en cours est hachuré (`ongoing`).
- **Repères** : bande de nuit (0→6 h et 20→24 h), ligne « maintenant » horodatée et
  voile sur le futur (aujourd'hui seulement).
- Tap sur une marque → **popover d'info ancré** (`#journalPop`) ; l'édition reste dans
  la vue Liste, pour qu'un tap dans une frise dense ne modifie jamais une donnée.

### Vue Appris

Toutes les nouveautés notées, **groupées par date**, du plus récent au plus ancien.
Tap sur une ligne = édition ; vider le champ vaut suppression (même confirmation).

### Vue Stats

Voir §7.

### Vue Prédiction

Voir §8. Expérimentale et **conditionnelle** (cf. `VIEWS` ci-dessus).

### Composants transverses

- **Bottom sheet** unique (`openSheet`/`closeSheet`) : sert à la création **et** à
  l'édition. Les **modules de champs** `FORMS[action.id]` (tetee, biberon, couche,
  temperature, medicament) produisent leur HTML pré-rempli et se câblent via
  `wire()` → renvoie un `getData()`. Réutilisés **à l'identique** en création (data
  vide) et en édition (data existante).
- **Éditeur d'heure réutilisable** (`timeFieldHTML` / `wireTimeField`) : champ `time`
  + boutons **−/+ 5 min**, borné à la journée.
- **Sommeil** : flux dédié début/fin. `activeSleep()` = un `sommeil` sans `end`
  démarré il y a **< 16 h** (`SLEEP_MAX_MS`) — évite qu'un dodo oublié gonfle sans fin.
- **Confirmation de suppression** (`askDelete(id, {icon, title, sub, ok, no, done})`) :
  **seul endroit d'app.js qui appelle `Store.remove`** — une garde de test le vérifie,
  donc aucun bouton ne peut supprimer sans poser la question. Boîte centrée
  (`#confirmBackdrop`, z-index 70) **au-dessus** de la feuille d'édition restée
  ouverte : « Annuler » ne fait rien perdre de la saisie. Le sous-titre rappelle
  l'événement visé (heure + détail, ou le texte du souvenir) et est injecté en
  `textContent`. La suppression est un soft-delete propagé aux deux téléphones et
  rien ne réaffiche un tombstone : côté utilisateur, c'est définitif.
- **Toast**, **vibration** (`navigator.vibrate`), **échappement HTML** (`escapeHtml`).
- **Pull-to-refresh** maison (`wirePullToRefresh`) : seuil 70 px, désactivé si un
  sheet/verrou est ouvert.

### Boucles de rafraîchissement

- `setInterval` 60 s : réactualise le bandeau « dernière fois » et les badges.
- `storage` event : synchro entre onglets du **même** appareil (invalide le cache).
- `visibilitychange` / `online` : re-fusion serveur au retour au premier plan.

---

## 7. Statistiques — couche pure `Stats` (stats.js)

`stats.js` est **100 % pur** : `Stats.compute(events, opts) → { days, today, averages,
period, quality }`. Aucune dépendance à l'UI, testable en isolation (on peut injecter
`opts.now`). Toute la **précision** vit ici. La vue Stats (dans app.js) ne fait que
consommer ce résultat et le rendre (cartes + graphes SVG).

### Règles de précision (résumé — détail complet dans `SPECS-stats.md`)

1. **Jour = jour civil local** (minuit → minuit du téléphone).
2. **Sommeil à cheval sur minuit → découpé à minuit** (minutes réellement dormies dans
   chaque jour) : 22 h 30 → 02 h vaut 1 h 30 le 1er jour et 2 h le 2e, et **1 dodo de
   chaque côté**.
   *Exception assumée* : « plus long sommeil » garde le sens de **plus longue traite sans
   réveil** → durée de l'**épisode entier**, rattachée au **jour qui en contient le plus
   de minutes** (à égalité : le jour de début). Sur ce jour, `longestSleepMin` peut donc
   **dépasser** `sleepMin` — ce n'est pas un bug.
3. **Dodo en cours** : compté jusqu'à maintenant si < 16 h ; sinon exclu **et signalé**.
4. **Dodo clos de ≥ 16 h** (`SLEEP_MAX_MS`, typiquement un arrêt oublié fermé le
   lendemain) : **compté quand même** — les stats restent le reflet exact du journal —
   mais **signalé** en qualité pour correction.
5. **Dodos qui se chevauchent** (la même sieste saisie depuis les deux téléphones) :
   minutes **additionnées** (idem) et le plus tardif **signalé**. Une journée peut donc
   dépasser 1440 min tant que le doublon n'est pas supprimé. *Aucune fusion automatique :
   c'est à l'humain de trancher lequel est le bon.*
6. **Invariant d'arrondi** : la somme des minutes des segments d'un épisode est
   **toujours** égale à son `totalMin` (pas de dérive ±1 min quand les secondes ≠ 0).
7. **Aujourd'hui = jour partiel** → **exclu des moyennes**, affiché à part (« à cette
   heure »). Mais les **ratios/totaux descriptifs** (part biberon, côtés, température
   max, bains, médicaments) portent sur **toute la fenêtre, aujourd'hui inclus**.
8. **Champ manquant** : l'événement compte dans son total, mais est exclu de la
   sous-métrique qui a besoin du champ (dénominateur explicite).
9. **Durée négative** (`end < start`) : bornée à 0 + signalée.
10. **Tombstones** (`deleted`) : toujours exclus.
11. **Portée de la qualité** : les anomalies sont cherchées **sur la fenêtre affichée
    uniquement** (tous domaines, sommeil compris) — la boîte suit le sélecteur 7/14/30 j.
    Listes triées du plus récent au plus ancien, **indépendamment de l'ordre d'arrivée**.
12. **Jour « suivi » = jour avec ≥ 1 événement.** Un jour totalement vide est « non
    suivi » et n'entre pas au dénominateur des moyennes (pas de faux zéro les jours où
    l'app n'a pas servi).
13. **Fiabilité par domaine** : avant sa date de début, un domaine est « pas de donnée »
    (aucune barre, exclu des moyennes) — **jamais un zéro** :
    - `repas` fiable depuis la **naissance (6 août 2026)** ;
    - `couches` / `sommeil` fiables **à partir du 11 août 2026** ;
    - 1er jour civil **complet** et moyennable = **7 août 2026** (le 6 est partiel).

### Primitives réutilisables

Trois fonctions publiques servent de **socle partagé** — l'UI, les stats et le prédictif
consomment les mêmes, pour qu'une règle n'existe jamais en deux exemplaires :

| Fonction | Renvoie |
|---|---|
| `sleepEpisodes(events, {nowMs})` | épisodes **triés par début croissant** : `{ id, startMs, endMs, min, ongoing, aberrant, overlapsPrev }` |
| `sleepSegments(ev, nowMs)` | l'épisode **découpé à minuit** : `{ dayMs, startMs, endMs, min, contPrev, contNext, ongoing, totalMin }` (utilisé aussi par la frise) |
| `feedTimeline(events)` | repas unifiés triés par heure : `{ atMs, kind: 'breast' \| 'bottle', ml }` |

### KPI produits

- **Alimentation** ★ (priorité produit = transition **sein → biberon**) : sein vs
  biberon /j, **part du biberon %**, volume bu, repas/j, intervalle moyen/max entre
  repas, durée de tétée moyenne, équilibre des côtés.
- **Couches** : pipis, cacas, couches totales, temps depuis le dernier caca.
- **Sommeil** : total/j (découpé minuit), plus long épisode, nombre de dodos.
- **Soins & santé** : température (dernière + max, alerte ≥ 38 °C), bains, médicaments.
- **Qualité des données** — **7 listes**, chaque anomalie **cliquable** pour ouvrir
  directement l'événement à corriger :

  | Clé (`quality.*`) | Anomalie |
  |---|---|
  | `couchesSansType` | couche sans pipi/caca/mixte |
  | `teteesSansCote` | tétée sans côté |
  | `dodosNonFermes` | dodo en cours depuis > 16 h (exclu des totaux) |
  | `dureesNegatives` | `end < start` (bornée à 0) |
  | `dureesAberrantes` | dodo **clos** de > 16 h (compté, mais improbable) |
  | `dodosChevauchants` | dodo qui chevauche le précédent (probable doublon à 2 téléphones) |
  | `tempHorsPlage` | température hors plage plausible 34–42 °C |

  Un test vérifie que **chaque** liste de `quality` a bien une entrée dans le `qTypes`
  d'app.js : une anomalie ajoutée dans stats.js ne peut pas rester muette à l'écran.

### Vue Stats (rendu, app.js)

- Sélecteur de période **7 / 14 / 30 j** (défaut 7).
- Bandeau « Aujourd'hui · à cette heure » (chiffres bruts, sans comparaison trompeuse).
- 7 cartes avec grand chiffre + sparkline.
- Section « Détails » repliée, encart « Qualité des données », bloc **Export**.

### Graphes SVG (charte dataviz)

Générés à la main (pas de lib), **4 formes** :

| Fonction | Forme | Emploi |
|---|---|---|
| `statChartBars` | barres | totaux /jour (repas, couches, sommeil…) |
| `statChartStacked` | barres empilées | sein vs biberon |
| `statChartLine` | ligne + points | part du biberon % |
| `statChartBand` | point + trait fin | **échelle tronquée** — la carte « Sommeil total » uniquement |

Points clés : `viewBox` uniforme, axes gradués via `niceMax`, extrémités arrondies
(`topRounded`), **`null` = pas de barre** (jamais un zéro), jours partiels **atténués**
(`fill-opacity`). Palette dataviz **CVD-safe** distincte des pastels d'UI :
sein = orange `#eb6834`, biberon = bleu `#2a78d6`, vert `#6f9e57` (sommeil/couches).

Deux règles de lisibilité livrées en v32 :

- **Cadence des étiquettes de valeur** proportionnelle à la fenêtre (`every`, compté **en
  partant du dernier jour** pour que le jour le plus récent soit toujours étiqueté) :
  **7 j → chaque jour, 14 j → 1 jour sur 2, 30 j → 1 sur 5**. Sur 30 jours, une valeur
  par barre est illisible ; on garde des repères, pas un mur de chiffres. Les libellés
  d'**abscisse** suivent la même logique (`xLabels`) : lettre du jour à 7 j, puis date
  `jj/mm` tous les 3 j (14 j) ou 6 j (30 j). L'**unité** (« % ») n'est écrite qu'une
  fois, sur le dernier point — les repères intermédiaires ne portent que le nombre.
- **Échelle tronquée ⇒ jamais une barre.** Le graphe de sommeil total ne montre que la
  bande **8 h → 20 h** (l'axe ne part pas de 0) : 12 h d'amplitude au lieu de 18 h, donc
  une lecture bien plus fine — mais une barre y mentirait sur les proportions (sa longueur
  ne serait plus proportionnelle à la valeur : c'est le biais classique des « barres
  tronquées »). D'où `statChartBand`, qui n'encode **que la position** : un point par
  jour, relié par une ligne fine. Un jour **hors bande** (typiquement le jour en cours,
  encore sous le plancher) est ramené sur la bordure, dessiné en **cercle creux**, et la
  ligne **s'y interrompt** — « hors échelle » se voit, aucun faux niveau n'est tracé.

---

## 8. Prédiction du sommeil & laboratoire (expérimental)

> Spécification de référence : **`RECOS-prediction-sommeil-v5.md`** (fait foi ; ce qui
> suit en est le résumé d'implémentation). Tout vit dans la couche pure `stats.js`, et
> **rien n'est persisté** : chaque rendu recalcule tout depuis le journal.

### 8.1 Ce que la vue annonce, et ce qu'elle refuse d'annoncer

L'onglet 🔮 estime **deux choses** et **rien d'autre** :

- l'**endormissement** à venir (à partir des **écarts d'éveil** : fin d'un dodo → début
  du suivant) ;
- le **réveil** (à partir des **durées d'épisodes**).

Il ne prétend pas expliquer *pourquoi*, ne donne **jamais un « % de confiance »**, et
n'affiche **aucune valeur fabriquée** : quand un modèle ne sait pas, il renvoie `null` et
l'écran le dit. Un bandeau rappelle que la vue est expérimentale.

### 8.2 Point d'entrée

```js
Stats.sleepPrediction(Store.all(), { now, domainStart: DATA_START, birth: BIRTH })
// → { nowMs, state, sinceMs, sinceMin, onset, duration, wake,
//     quality1, quality2, roundtrip, context, ready }
```

- **États** : `AWAKE` (ancre = dernier réveil réel), `ASLEEP` (ancre = début du dodo en
  cours), `UNKNOWN` (rien d'exploitable). L'ancre est **toujours un fait du journal**,
  jamais une valeur prédite.
- **Distributions** (`_predDist`) : **médiane** + **P25/P75** — et les percentiles
  n'apparaissent qu'**au-delà d'un nombre minimal d'échantillons** (en dessous : une
  valeur ponctuelle, pas une fausse plage).
- **Plage de réveil** — la source est explicite (`wake.basis`) :

  | `basis` | Comment la plage est obtenue |
  |---|---|
  | `roundtrip` | **calibrée sur l'erreur réellement observée** de la chaîne endormissement→réveil (P25/P75 des résidus signés) — le cas nominal |
  | `somme` | repli tant qu'aucun aller-retour n'a été vérifié : somme des deux plages (trop large, annoncé comme tel) |
  | `point` | médiane seule, aucune plage défendable |
  | `duree` | état `ASLEEP` : plage des durées, ancrée au début du dodo réel |

### 8.3 Backtests walk-forward, sans fuite du futur

Trois séries de backtests sont rejouées à chaque appel : endormissement (`quality1`),
réveil (`quality2`), aller-retour (`roundtrip`). Chaque prédiction est refaite **à la
date où elle aurait été faite** (au réveil, ou à l'endormissement) et n'utilise que les
échantillons dont `atMs <= asOfMs` (recherche par dichotomie, `_lowerBound`). Une
prédiction « telle qu'elle était à S6 » ne peut donc jamais emprunter des données de S10.

**Recul et performance sont séparés**, jamais fusionnés :

- **recul** = `n` prédictions vérifiées → palier `debut` / `intermediaire` / `solide` ;
- **performance** = erreur médiane absolue, P80 absolu, et résidus **signés** P25/P75
  (le signe dit *dans quel sens* on se trompe — indispensable pour calibrer une plage).

### 8.4 Le laboratoire Champion / Challengers

`Stats.sleepLab(events, { domainStart, birth })` — même philosophie : **tout calculer
tôt, tout comparer en walk-forward, tout montrer, ne rien promouvoir automatiquement.**

- **M0 « Baseline récente » est le champion** : médiane sur 14 j / 40 échantillons —
  c'est *lui* que `sleepPrediction` affiche. Il sert d'**expérience contrôle**.
- **12 challengers** (11 implémentés + 1 déclaré) **en shadow mode** : ils produisent
  prédiction + backtest sans **aucun** effet sur l'estimation affichée.

| Famille | Modèles |
|---|---|
| Sommeil seul | **M1** récence/fenêtre courte · **M2** sommeil restant · **M3** contexte horaire · **M4** sommeil précédent · **M5** éveil précédent · **M6** structure jour/nuit · **M7** récence pondérée (demi-vie 72 h) |
| Rythme des repas | **MF1** délai depuis le dernier repas · **MF2** type du dernier repas · **MF3** volume du dernier biberon · **MF4** grappe de repas (3 h) |
| Déclaré, non implémenté | **M8** hybride ciblé (`predict` absent — un test vérifie qu'aucun bouton ne prétend le lancer) |

**Trois cibles** (`LAB_TARGETS`) : `onset` (endormissement), `wake` (réveil), et
`remaining` — le réveil **ré-estimé pendant que bébé dort encore**, avec la sonde placée
à l'heure que M0 avait annoncée : ce cas n'existe donc que si l'épisode a **dépassé** la
prédiction du champion.

**Comparaison appariée** : le gain d'un challenger est `|err(M0)| − |err(Mx)|` **sur les
cas où les deux ont prédit**. Comparer deux moyennes calculées sur des cas différents ne
voudrait rien dire.

### 8.5 Cycle de vie d'une expérience (modèle × cible)

`collecte → shadow → exploration → confirmation` — et **`active` / `rejected` restent des
décisions humaines** : le code ne promeut jamais un modèle tout seul.

| Statut | Condition (dérivée des seuls cas) |
|---|---|
| `collecting` | pas encore de cas appariés (ou, pour M1, les deux fenêtres donnent encore exactement la même prédiction) |
| `shadow` | des cas appariés, mais < 20 : trop peu pour lire un signal |
| `exploration` | ≥ 20 cas appariés — **résultat exploratoire**, pas une conclusion |
| `confirming` | gelé sur un bloc de cas **non recouvrant** ; au plus **2 confirmations en parallèle**, les suivantes attendent en file |
| `active` / `rejected` | **humain uniquement** |

Le statut d'un modèle = le **plus avancé** de ses expériences. Les seuils sont des
constantes **produit** assumées (`FEATURE_*`), jamais des frontières biologiques et
jamais déduites de l'âge du bébé.

### 8.6 Les repas comme challengers (et les données qu'on refuse d'inventer)

Le rythme des repas entre dans le prédictif **en challenger mesuré**, jamais en règle
codée en dur. Les caractéristiques (`_labFeedFeat`) : `sinceFeedMin`, `feedKind`,
`lastBottleMl`, `feeds3h`, `feedCluster` (`sparse` / `steady` / `cluster`).

Trois refus explicites, parce qu'une donnée inventée contaminerait tous les backtests :

1. **Aucune fin de repas fabriquée** (pas de `ts + 15 min`) : on ne note que le début.
2. **La durée d'une tétée est un préréglage tapé**, pas une mesure → jamais une
   caractéristique, et **jamais convertie en volume**.
3. **Au-delà de 12 h** sans repas noté, tout passe à `null` : ce n'est plus un jeûne,
   c'est un repas qu'on a oublié de noter.

### 8.7 Rendez-vous de lecture (checkpoints)

Semaines d'âge **3, 4, 6, 8, 10, 12, 16**, puis toutes les 4 semaines. Un checkpoint est
un **rendez-vous de lecture** — il ne démarre aucun modèle (tout ce qui est calculable
l'est déjà avant). S3 = **checkpoint alimentation** (MF1–MF4), S4 récence, S6 ASLEEP,
S8 heure, S10 mémoire courte, S12 structure, S16 récence adaptative.

### 8.8 Rendu (app.js) et non-persistance

`renderPrediction()` affiche : carte **Contexte** (âge, jours de sommeil suivis, épisodes
retenus, exclusions), **estimation du moment** (🌙 endormissement / 🌅 réveil), 3 cartes
de qualité (endormissement / réveil / aller-retour), 2 tableaux prédiction-vs-réalité,
puis `renderLab()` → 7 cartes (état du moment, performance, évolution par semaine d'âge,
checkpoints, cas, expériences, export).

Trois détails de rendu qui ont chacun une raison :

- **Le tic de 60 s ne rejoue pas les backtests.** L'onglet Prédiction rafraîchit
  uniquement les durées relatives (« il y a 1 h 20 », « dans ~40 min ») via
  `refreshPredictionRel()`, qui réécrit un seul bloc à partir de `predLast` (la dernière
  prédiction rendue). Recalculer `sleepLab()` chaque minute coûterait des dizaines de
  backtests pour un résultat identique.
- **Bandeau de suggestions** (`labSuggestions()` → `#labSuggest`) : ce que le labo
  propose de regarder maintenant (une expérience prête à confirmer, un checkpoint
  atteint). Chaque suggestion est **écartable** — et `labDismissed` étant en mémoire,
  elle revient au prochain passage sur l'onglet : rien n'est masqué durablement.
- **Pagination des cas explicite** : `LAB_CASES_PAGE = 20` cas par palier, et le reste
  est **annoncé** (« Afficher N cas de plus ») au lieu d'être tronqué en silence — un
  tableau qui s'arrête sans le dire se lit comme un tableau complet.

**Rien n'est persisté** (`labLast` / `labDismissed` / `labUI` sont en mémoire seulement) :
une clé `localStorage` figerait une comparaison faite sur d'anciennes données. **Une garde
de test l'interdit** (§12).

---

## 9. Export (pour analyse / IA)

**4 formats.** Trois depuis la vue Stats (`exportJSON` / `exportEventsCSV` /
`exportDailyCSV`), un depuis l'onglet Prédiction (`exportLabJSON`) :

1. **JSON brut** : tous les événements + en-tête méta (`exported_at`, `timezone`,
   `tz_offset_min`, `app_version`, `schema_version`, `includes_deleted`, `count`).
   `app_version` est **dérivée de l'URL de l'asset** (`document.currentScript`), jamais
   écrite à la main — un test l'impose, faute de quoi l'export s'horodate faux.
2. **CSV événements** (1 ligne = 1 événement) : colonnes typées et aplaties
   (`side`, `duration_min`, `volume_ml`, `couche_type`, `is_pee`, `is_poop`, `temp_c`,
   `med_name`, `sleep_end_utc`, `sleep_duration_min`, `deleted`…).
3. **CSV agrégat quotidien** (1 ligne = 1 jour) : tous les KPI /jour. `partiel=1` pour
   aujourd'hui et le jour de naissance ; colonnes couche/sommeil **vides** (jamais 0)
   tant que le domaine n'est pas fiable — pour ne pas induire l'analyse en erreur.
4. **JSON du laboratoire** (`Stats.labExport(lab)`, schéma `sleep-prediction-lab/1.1`,
   bouton dans l'onglet Prédiction) : snapshot **auto-suffisant** destiné à être lu par un
   LLM — les **conventions de signe et les définitions voyagent dans le fichier**, pour
   qu'aucune spec ni conversation antérieure ne soit nécessaire pour l'interpréter.
   Généré **localement** dans le navigateur : rien n'est envoyé à un serveur.
   *Confidentialité par défaut* (`privacyMode: 'sleep-and-feeding-deidentified'`) :
   **sommeil + rythme des repas** (délai, type, volume des biberons, nombre sur 3 h —
   puisque c'est ce que les modèles MF testent) et **rien des autres domaines** ;
   identifiant neutre (`baby-1`), **âge en jours**, aucune date de naissance, aucun nom.
   *(Le périmètre était « sommeil seul » en schéma 1.0 ; l'ajout des repas est ce qui a
   fait passer le schéma en 1.1.)*

---

## 10. PWA & hors-ligne (sw.js + manifest)

- **Manifeste** : `standalone`, `portrait`, icônes maskables 192/512, thème blanc.
- **Service worker** (`sw.js`, cache `suivi-bebe-v33`) :
  - `install` → pré-cache la liste `ASSETS` (app shell + vendor + icônes).
  - `activate` → purge les anciens caches (≠ version courante).
  - `fetch` : **navigations** = réseau d'abord, repli sur `index.html` en cache ;
    **autres GET** = cache d'abord puis réseau (et mise en cache au passage).
- Le client Supabase est **embarqué** dans `vendor/supabase.js` (pas de CDN → marche
  hors-ligne).

⚠️ **Rappel de maintenance** : à chaque changement d'asset, bumper `?v=N` dans
`index.html` **et** la constante `CACHE` dans `sw.js`, sinon les clients installés
garderont l'ancienne version en cache. **Un test le vérifie dans les deux sens** (§12),
donc l'oubli est bloquant, pas silencieux.

Les numéros de version ne sont pas contigus : les assets ne bougent pas tous ensemble
(`stats.js` est à `?v=31`, `config.js` à `?v=15`) et **la v29 n'a jamais existé** — le
`CACHE` est passé de `v28` à `v30` (le prédictif touchait tellement de fichiers qu'il a
pris le numéro suivant d'un coup). Pas un trou dans l'historique : `9ae6a6b` v27 →
`4587a7d` v28 → `e048f9c` v30 → `70bcb74` v31 → `94dba9e` v32 → `a18601d` v33.

---

## 11. Thème & style (styles.css)

- Variables CSS `:root` : surfaces, texte, ombre, rayon (`--radius: 20px`), et une
  **couleur par domaine** (`--c-tetee`, `--c-sommeil`…).
  Palette : vert `#8EBA73` · rose `#CF8AB3` · bleu `#80B4D7` · orange `#C7774A` ·
  jaune `#D9C163`.
- Mobile-first : conteneur max **560 px** centré, **safe-areas iOS**
  (`env(safe-area-inset-*)`), pas de zoom (`user-scalable=no`), sélection de texte
  désactivée sauf dans les champs.
- Anti-autofill : un champ identifiant fictif « foyer » dans l'écran de verrouillage
  détourne l'autocomplétion du navigateur des vrais champs de l'app.

### Empilement (z-index) — l'ordre a un sens

| Couche | z | Pourquoi ici |
|---|---|---|
| barre d'onglets | 40 | au-dessus du contenu |
| pastille de synchro | 41 | au-dessus de la barre d'onglets |
| **bottom sheet** | 50 | saisie / édition |
| popover de la frise | 60 | info ponctuelle |
| **confirmation de suppression** | **70** | au-dessus de la feuille **restée ouverte** → « Annuler » ne fait rien perdre |
| toast | 100 | toujours lisible |
| écran de verrouillage | 200 | barrière absolue |

L'ordre `50 < 70 < 100` est **vérifié par un test** (§12) : une confirmation cachée sous
la feuille qu'elle est censée protéger serait un piège à tap.

---

## 12. Tests

```bash
node tests/run.js
```

Suite **sans aucune dépendance** (pas de `package.json`, pas de build, node seul) :
**103 cas · ~104 000 assertions**. Un filtre optionnel en argument ne joue que les
fichiers correspondants (`node tests/run.js lab`).

Deux détails du harnais évitent des faux verts :

- il se **ré-exécute automatiquement avec `TZ=Europe/Paris`** — tous les tests de
  frontière de jour en dépendent (un fuseau différent ferait passer des tests faux) ;
- `stats.js` est chargé tel quel via `eval(src.replace('const Stats =', 'global.Stats ='))` :
  le fichier étant **pur**, aucun DOM n'est nécessaire — et un test vérifie qu'il le reste
  (aucun `document.`, `localStorage`, `fetch`, `console.`…).

### Ce qui est couvert

| Fichier | Couverture |
|---|---|
| `stats.test.js` | les règles de §7 : découpe à minuit, heure d'été/hiver (jour de 23 h / 25 h), bornes 16 h, invariant Σ segments = total, dénominateurs des moyennes, les 7 listes de qualité, + des tests de **propriétés** sur scénarios pseudo-aléatoires (PRNG déterministe, jamais `Math.random`) |
| `prediction.test.js` | échantillons, backtests walk-forward, **absence de fuite du futur**, états AWAKE/ASLEEP/UNKNOWN, bases de plage |
| `lab.test.js` | cas du laboratoire, comparaison appariée, cycle de vie des statuts, checkpoints, export LLM, **famille MF** (features de repas, §8.6) |
| `guards.test.js` | gardes au niveau des **sources** (ci-dessous) |

### Les gardes sur les sources — ce qu'un test unitaire ne peut pas voir

Ce sont des règles de projet rendues **automatiques**, chacune née d'une vraie erreur :

- **aucun bloc de démo** (`suivi-bebe-DEMO`, `DEMO_EVENTS`, `seedDemo`) dans les sources —
  la règle « à retirer avant tout push » ne dépend plus de ma mémoire ;
- **cache du service worker aligné** : `CACHE` = max des `?v=N`, `ASSETS` ⊇ URLs
  versionnées d'`index.html`, et **aucune URL périmée** dans `ASSETS` ;
- **aucune suppression sans confirmation** : un **seul** appel à `Store.remove` dans
  app.js, à l'intérieur d'`askDelete`, boîte de dialogue présente, z-index correct ;
- **arithmétique de jours** toujours via `Math.round` ou `Stats.addDays` (un écart en ms
  divisé par 86 400 000 vaut 6,96 ou 7,04 jours autour d'un changement d'heure) ;
- **version d'export dérivée de l'asset**, jamais écrite en dur ;
- **drapeaux de fiabilité** (`domainStart` + `firstCompleteDay`) passés à **chaque** appel
  à `Stats.compute` — sans eux, les moyennes se remettent à diviser par des jours sans
  donnée (régression silencieuse et invisible) ;
- **découpe à minuit non dupliquée** dans app.js (elle délègue à `Stats.sleepSegments`) ;
- **surface publique de `stats.js`** conforme au contrat ;
- `LAB_STATUS` (app.js) ≡ `Stats.LAB_STATUS_ORDER` **dans les deux sens** (sinon un statut
  s'afficherait en brut, ou un statut fantôme traînerait) ;
- **le laboratoire ne persiste rien**, et **M8 n'a pas de bouton** ;
- **chaque liste de `quality`** a une entrée dans `qTypes` (pas d'anomalie muette).

### Hors périmètre, assumé

La synchro `Store`/Supabase (couplée localStorage + réseau, non testable sans extraction)
et le rendu UI. Ainsi que la détection de **repas en double** : contrairement au sommeil,
deux repas rapprochés ne sont pas physiquement impossibles — aucune heuristique fiable.

---

## 13. Lancer en local

```bash
python3 -m http.server 4321
```

Puis ouvrir <http://localhost:4321>. Sans `config.js` valide, l'app fonctionne 100 %
en local (aucune synchro requise pour développer).

Avant tout commit :

```bash
node tests/run.js
```
