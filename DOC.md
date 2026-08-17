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

Principe fondateur : **une seule source de vérité, le journal d'événements brut**.
Aucune statistique n'est stockée — tout est **recalculé à la volée**. Corriger un
événement corrige automatiquement toutes les vues et stats (pas de dérive).

---

## 2. Structure des fichiers

```
Suivi bébé/
├── index.html            # Coquille de l'app : 3 vues, sheet, verrou, toast
├── app.js                # Toute la logique UI + couche Store (localStorage + Supabase)
├── stats.js              # Couche de calcul PURE (event[] → KPI), sans dépendance UI
├── styles.css            # Thème, tuiles, sheet, graphes, écran de verrouillage
├── config.js             # Config Supabase (url / anon / email foyer) — valeurs publiques
├── sw.js                 # Service worker PWA (cache offline, versionné)
├── manifest.webmanifest  # Manifeste PWA (nom, icônes, standalone, portrait)
├── vendor/supabase.js    # Client Supabase embarqué (pas de CDN → offline)
├── icons/                # Icônes PWA (192, 512, apple-touch)
├── tools/gen_icons.py    # Génération des icônes (cœur blanc sur dégradé rose→bleu)
├── SPECS-stats.md        # Spécification détaillée du reporting / KPI
└── README.md             # Notes de lancement
```

**Versionnage des assets** : les URL portent `?v=N` (`styles.css?v=22`, `app.js?v=22`…)
et le cache du service worker (`CACHE = 'suivi-bebe-v22'`) est aligné sur ce numéro.
Toute mise à jour d'asset doit **incrémenter `N` aux deux endroits** pour forcer le
rechargement chez les clients installés.

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
| `yeux` / `nez` / `cordon` | checklist | `{}` | soins quotidiens |
| `appris` | (ni tile ni checklist) | `text` | journal des nouveautés, hors stats |

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
| `suivi-bebe-DEMO` | `'1'` = mode démo (recule les dates de fiabilité — voir §8) |

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

Trois vues, une **barre d'onglets** (`VIEWS`) : **Suivi 📋 · Appris ✨ · Stats 📊**.

### Vue Suivi (écran principal)

- **Barre de date** : navigation jour précédent/suivant (pas de futur). Un jour ≠
  aujourd'hui grise légèrement le fond (`body.other-day`).
- **Bandeau « dernière fois »** (`status-strip`) : pour tétée/biberon/couche/sommeil,
  temps écoulé depuis la dernière fois (ou chrono du dodo en cours).
- **Checklist quotidienne** : gestes systématiques (vitamine D, ventre, yeux, nez,
  cordon). 1 tap = fait (avec l'heure) ; re-tap = édition.
- **Grille de tuiles** : gros boutons ouvrant un **bottom sheet** de saisie. Chaque
  tuile affiche un **badge compteur du jour** (`tileStat`) : nb + durée/volume/💧💩.
- **« Ce que j'ai appris »** : ajout rapide d'une nouveauté du jour.
- **Journal du jour** (`timeline`) : liste chronologique éditable des événements
  (hors « appris »).

### Vue Appris

Toutes les nouveautés notées, **groupées par date**, du plus récent au plus ancien.

### Vue Stats

Voir §7.

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
   chaque jour). Le *nombre* de dodos et le *plus long épisode* se calculent sur
   l'épisode entier, rattaché au jour de **début**.
3. **Dodo en cours** : compté jusqu'à maintenant si < 16 h ; sinon exclu **et signalé**.
4. **Aujourd'hui = jour partiel** → **exclu des moyennes**, affiché à part (« à cette
   heure »). Mais les **ratios/totaux descriptifs** (part biberon, côtés, température
   max, bains, médicaments) portent sur **toute la fenêtre, aujourd'hui inclus**.
5. **Champ manquant** : l'événement compte dans son total, mais est exclu de la
   sous-métrique qui a besoin du champ (dénominateur explicite).
6. **Durée négative** (`end < start`) : bornée à 0 + signalée.
7. **Tombstones** (`deleted`) : toujours exclus.
8. **Fiabilité par domaine** : avant sa date de début, un domaine est « pas de donnée »
   (aucune barre, exclu des moyennes) — **jamais un zéro** :
   - `repas` fiable depuis la **naissance (6 août 2026)** ;
   - `couches` / `sommeil` fiables **à partir du 11 août 2026** ;
   - 1er jour civil **complet** et moyennable = **7 août 2026** (le 6 est partiel).

### KPI produits

- **Alimentation** ★ (priorité produit = transition **sein → biberon**) : sein vs
  biberon /j, **part du biberon %**, volume bu, repas/j, intervalle moyen/max entre
  repas, durée de tétée moyenne, équilibre des côtés.
- **Couches** : pipis, cacas, couches totales, temps depuis le dernier caca.
- **Sommeil** : total/j (découpé minuit), plus long épisode, nombre de dodos.
- **Soins & santé** : température (dernière + max, alerte ≥ 38 °C), bains, médicaments.
- **Qualité des données** : couches sans type, tétées sans côté, dodos non fermés,
  durées négatives, températures hors plage — **chaque anomalie est cliquable** pour
  corriger l'événement.

### Vue Stats (rendu, app.js)

- Sélecteur de période **7 / 14 / 30 j** (défaut 7).
- Bandeau « Aujourd'hui · à cette heure » (chiffres bruts, sans comparaison trompeuse).
- 7 cartes avec grand chiffre + sparkline (graphes SVG maison :
  `statChartBars`, `statChartStacked`, `statChartLine`).
- Section « Détails » repliée, encart « Qualité des données », bloc **Export**.

### Graphes SVG (charte dataviz)

Générés à la main (pas de lib). Points clés : `viewBox` uniforme, axes gradués via
`niceMax`, extrémités arrondies (`topRounded`), **`null` = pas de barre** (jamais un
zéro), jours partiels **atténués** (`fill-opacity`). Palette dataviz **CVD-safe**
distincte des pastels d'UI : sein = orange `#eb6834`, biberon = bleu `#2a78d6`,
vert `#6f9e57` (sommeil/couches).

---

## 8. Export (pour analyse / IA)

Depuis la vue Stats, 3 formats (fonctions `exportJSON` / `exportEventsCSV` /
`exportDailyCSV`) :

1. **JSON brut** : tous les événements + en-tête méta (`exported_at`, `timezone`,
   `tz_offset_min`, `app_version`, `schema_version`, `count`).
2. **CSV événements** (1 ligne = 1 événement) : colonnes typées et aplaties
   (`side`, `duration_min`, `volume_ml`, `couche_type`, `is_pee`, `is_poop`, `temp_c`,
   `med_name`, `sleep_end_utc`, `sleep_duration_min`, `deleted`…).
3. **CSV agrégat quotidien** (1 ligne = 1 jour) : tous les KPI /jour. `partiel=1` pour
   aujourd'hui et le jour de naissance ; colonnes couche/sommeil **vides** (jamais 0)
   tant que le domaine n'est pas fiable — pour ne pas induire l'analyse en erreur.

---

## 9. PWA & hors-ligne (sw.js + manifest)

- **Manifeste** : `standalone`, `portrait`, icônes maskables 192/512, thème blanc.
- **Service worker** (`sw.js`, cache `suivi-bebe-v22`) :
  - `install` → pré-cache la liste `ASSETS` (app shell + vendor + icônes).
  - `activate` → purge les anciens caches (≠ version courante).
  - `fetch` : **navigations** = réseau d'abord, repli sur `index.html` en cache ;
    **autres GET** = cache d'abord puis réseau (et mise en cache au passage).
- Le client Supabase est **embarqué** dans `vendor/supabase.js` (pas de CDN → marche
  hors-ligne).

⚠️ **Rappel de maintenance** : à chaque changement d'asset, bumper `?v=N` dans
`index.html` **et** la constante `CACHE` dans `sw.js`, sinon les clients installés
garderont l'ancienne version en cache.

---

## 10. Thème & style (styles.css)

- Variables CSS `:root` : surfaces, texte, ombre, rayon (`--radius: 20px`), et une
  **couleur par domaine** (`--c-tetee`, `--c-sommeil`…).
  Palette : vert `#8EBA73` · rose `#CF8AB3` · bleu `#80B4D7` · orange `#C7774A` ·
  jaune `#D9C163`.
- Mobile-first : conteneur max **560 px** centré, **safe-areas iOS**
  (`env(safe-area-inset-*)`), pas de zoom (`user-scalable=no`), sélection de texte
  désactivée sauf dans les champs.
- Anti-autofill : un champ identifiant fictif « foyer » dans l'écran de verrouillage
  détourne l'autocomplétion du navigateur des vrais champs de l'app.

---

## 11. Point de vigilance (données de test)

`app.js` contient un bloc **⚠️ DONNÉES DE TEST — À SUPPRIMER AVANT LE PUSH ⚠️** : si le
drapeau `localStorage['suivi-bebe-DEMO'] === '1'`, les dates de fiabilité
(`DATA_START`, `FIRST_COMPLETE_DAY`) sont reculées au 10-11 juillet 2026 pour remplir
tous les graphes en démo. À retirer / laisser inactif en production.

---

## 12. Lancer en local

```bash
python3 -m http.server 4321
```

Puis ouvrir <http://localhost:4321>. Sans `config.js` valide, l'app fonctionne 100 %
en local (aucune synchro requise pour développer).
