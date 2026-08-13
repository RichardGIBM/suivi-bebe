# Specs — Reporting / KPI « Suivi Bébé »

> Objectif : suivre l'évolution dans le temps (tétées, biberons, pipi/caca, sommeil…)
> avec des indicateurs **simples mais utiles**, une **précision sans faille**, et une
> **exhaustivité des données** exportables pour analyse/prédiction par une IA.
>
> Statut : **implémenté** (`stats.js`, onglet 📊). Spec vivante : elle décrit le code
> livré, et chaque règle ci-dessous est **verrouillée par un test** (`node tests/run.js`,
> voir §J). Toute modification de règle se fait ici **et** dans les tests, ensemble.

---

## 0. Principe directeur : la précision d'abord

Tous les calculs partent du **même journal d'événements** déjà en base
(`{ id, action, data, ts, updated_at, deleted }`). Aucune donnée dérivée n'est
stockée : les KPI sont **recalculés à la volée** depuis les événements bruts →
une correction d'un événement corrige automatiquement toutes les stats. Pas de
double source de vérité, donc pas de dérive.

### Modèle de données réel (source de vérité)

| action | `data` | Remarques précision |
|---|---|---|
| `tetee` | `side?` ∈ {gauche, droite, les deux}, `duration?` (min) | **les deux champs sont optionnels** |
| `biberon` | `ml` (nombre) | défaut 90 à la saisie, mais on garde un garde-fou si absent |
| `couche` | `type?` ∈ {pipi, caca, mixte} | **type optionnel** ; `mixte` = pipi **ET** caca |
| `sommeil` | `end` (ISO \| null) | `ts` = coucher, `end` = réveil ; `null` = en cours |
| `bain` | `{}` | horodatage seul |
| `temperature` | `temp` (°C, 1 décimale) | |
| `medicament` | `name?` (texte) | nom optionnel |
| `vitamined`, `ventre`, `yeux`, `nez`, `cordon` | `{}` | cases à cocher = horodatage seul |
| `appris` | `text` | hors périmètre stats |

### Règles de calcul transversales (à appliquer partout, sans exception)

1. **Jour = jour civil local** (minuit → minuit, heure du téléphone), cohérent avec
   l'existant. Un « /24h » = un jour civil.
2. **Sommeil à cheval sur minuit → découpé à minuit.** Un dodo 22h30→06h15 compte
   1h30 la veille et 6h15 le lendemain. C'est la **seule** façon correcte d'obtenir
   « heures de sommeil par jour ». (Le *nombre* de dodos et la *plus longue période*
   se calculent sur l'épisode entier, voir §C.)
   **Invariant d'arrondi** : la somme des minutes des segments d'un épisode est
   toujours égale à la durée de l'épisode (`totalMin`) — on répartit, on ne
   ré-arrondit pas chaque morceau indépendamment.
3. **Épisodes de sommeil douteux.** La borne de plausibilité est unique : 16 h
   (`SLEEP_MAX_MS`), en cours **comme** clos.
   - **en cours** (`end:null`) démarré il y a < 16 h : compté jusqu'à **maintenant** ;
   - **en cours** depuis > 16 h (oubli de « fin ») : **exclu** des totaux et **signalé** (§E) ;
   - **clos** de durée ≥ 16 h (oubli fermé le lendemain) : **compté quand même** et
     **signalé** (§E). Les stats restent le reflet exact du journal ; c'est la
     correction de la saisie qui corrige la stat, pas un filtre invisible ;
   - **qui se chevauchent** (même sieste saisie depuis les 2 téléphones) : minutes
     **additionnées** (idem) et le plus tardif **signalé** (§E). Une journée peut donc
     dépasser 1440 min tant que le doublon n'est pas supprimé.
   > Conséquence pour le **prédictif** : c'est à lui d'écarter les épisodes marqués
   > `aberrant` ou `overlapsPrev` par `Stats.sleepEpisodes()` — les stats descriptives,
   > elles, ne mentent pas sur ce qui est saisi.
4. **Aujourd'hui est un jour partiel.** Les **moyennes /jour** se calculent sur les
   **N jours complets précédents** (aujourd'hui exclu). Aujourd'hui est affiché à part
   (« aujourd'hui, à cette heure »), jamais mélangé à la moyenne.
   **En revanche**, les **ratios/totaux de période descriptifs** (part du biberon,
   équilibre des côtés, durée moyenne de tétée, intervalles, **température max**,
   bains, médicaments) sont calculés sur **toute la fenêtre, aujourd'hui inclus** —
   sinon une fièvre ou un médicament d'aujourd'hui serait masqué.
   « Jour suivi » = jour avec ≥ 1 événement de **routine** (tétée, biberon, couche,
   sommeil valide, température, bain, médicament). La checklist et les « appris » ne
   qualifient pas un jour de suivi, et un **dodo invalide** (oublié > 16 h) non plus —
   sans quoi ces jours ajouteraient de **faux zéros** aux moyennes.
5. **Champs manquants** : un événement compte toujours dans son total de haut niveau
   (une tétée sans durée reste une tétée). Il n'est exclu **que** de la sous-métrique
   qui a besoin du champ absent (ex. « durée moyenne de tétée » ne porte que sur les
   tétées ayant une `duration`). Le dénominateur de chaque moyenne est donc explicite.
6. **Durées** : minutes en interne ; affichage `h/min` via `fmtDuration`. Une durée
   négative (édition erronée `end < start`) est **bornée à 0** et signalée en §E.
7. **Volumes** ml entiers ; **température** 1 décimale ; **pourcentages** entiers ;
   **moyennes** 1 décimale.
8. **Tombstones** (`deleted:true`) : **toujours exclus** des stats.
9. **Fiabilité par domaine (dates de début).** Toutes les données ne sont pas fiables
   depuis le même jour. Un domaine est affiché **à partir de sa date de début** ; avant,
   c'est **« pas de donnée »** (aucune barre, exclu des moyennes), **jamais un zéro**.
   - `repas` (tétées/biberons) : fiables **depuis la naissance, le 6 août 2026** ;
   - `couches` et `sommeil` : fiables **à partir du 11 août 2026** (les premiers jours
     étaient incomplets).
   Le **6 août n'est pas une journée complète** (naissance à 5 h 25) : il est **exclu des
   moyennes /jour** (comme aujourd'hui), même si ses tétées/biberons sont bien comptés
   et exportés. Le 1er jour civil complet et moyennable est donc le **7 août 2026**.
   Ces bornes sont centralisées côté app (`DATA_START`, `FIRST_COMPLETE_DAY`) et passées
   à la couche pure ; elles seront à ajuster si la fiabilité change.

---

## A. Alimentation ★ (priorité produit : transition sein → biberon)

Objectif explicite des parents : **glisser progressivement vers le tout-biberon**.
L'indicateur central n'est donc pas « combien de repas » mais **l'évolution du
partage sein vs biberon dans le temps**.

| # | KPI | Définition exacte | Dénominateur / edge cases |
|---|---|---|---|
| A1 ★ | **Sein vs Biberon / 24h** | `count(tetee)` et `count(biberon)`, deux séries par jour | courbe/barres empilées sur la période |
| A2 ★ | **Part du biberon** | `count(biberon) / (count(tetee)+count(biberon))` par jour, en % | **c'est la métrique de transition** : doit tendre vers 100 %. « — » si 0 repas |
| A3 | **Volume bu / 24h** | `Σ biberon.ml` sur le jour | tétées non comptées (volume inconnu) ; monte avec la transition |
| A4 | **Repas / 24h** (total) | `count(tetee) + count(biberon)` | contrôle : le total reste stable pendant qu'on bascule |
| A5 | **Intervalle moyen / plus long** | écarts entre repas (tétées+biberons) triés par heure | besoin ≥ 2 repas, sinon « — » |
| A6 | **Durée de tétée moyenne** | `moyenne(tetee.duration)` sur la période | **uniquement** tétées avec `duration` |
| A7 | **Équilibre des côtés** | % gauche / % droite ; `les deux` = +0,5 à chaque côté | uniquement tétées avec `side` |

- **Note lait maternel vs biberon** : le volume (A3) ne concerne que le biberon.
  On ne « devine » jamais un volume de tétée. Assumé et affiché tel quel.
- La **part du biberon** (A2) est le fil rouge : carte principale + tendance sur
  toute la période pour visualiser la bascule.

---

## B. Couches

| # | KPI | Définition exacte | Edge cases |
|---|---|---|---|
| B1 | **Pipis / 24h** | `count(type ∈ {pipi, mixte})` | signal d'hydratation (repère pédiatrique : ≥ 5–6/j) |
| B2 | **Cacas / 24h** | `count(type ∈ {caca, mixte})` | |
| B3 | **Couches totales / 24h** | `count(couche)` | inclut celles sans `type` |
| B4 | **Intervalle moyen entre 2 cacas** | moyenne des écarts entre cacas/mixtes consécutifs sur la période | besoin ≥ 2 cacas, sinon « — ». Le « temps depuis le dernier caca » (veille de constipation) vit dans l'onglet Suivi, pas ici : Stats = tendance, pas instantané. |

- Couches **sans `type`** : comptent dans B3, **pas** dans B1/B2, et sont signalées en §E
  (donnée incomplète).

---

## C. Sommeil

| # | KPI | Définition exacte | Edge cases |
|---|---|---|---|
| C1 | **Sommeil total / 24h** | Σ des minutes dormies **dans** le jour (découpe à minuit, §règle 2) | dodo en cours borné à maintenant |
| C2 | **Plus longue période** | durée de l'épisode **entier** (non découpé), rattachée au jour qui en contient **le plus de minutes** — à égalité, le jour de **début** | la « nuit » de 22h30→06h15 s'affiche 7h45 sur le lendemain, pas 1h30 la veille |
| C3 | **Nombre de dodos / 24h** | nombre de **segments** du jour : un épisode à cheval compte **1 dodo de chaque côté** de minuit | cohérent avec C1 (mêmes segments) |

> ~~C4 jour vs nuit~~ : **écarté** (pas besoin — décision 2026-08-11).

- **Cohérence C1/C3** : même découpage, donc toujours cohérents (n dodos ⇒ n segments
  de minutes dans le jour).
- **Exception assumée sur C2** : l'épisode entier étant rattaché à un seul jour,
  `longestSleepMin` peut **dépasser** `sleepMin` de ce jour (20h→04h : 240 min dormies
  le jour de début, mais « plus long dodo » = 480 min le lendemain). C'est voulu :
  C2 doit garder le sens de « plus longue traite sans réveil ».
- Un jour dont le seul contenu est la **fin d'une nuit** est bien un jour « suivi ».
- Épisode `end < start` (édition erronée) : borné à 0 + signalé §E ;
  `end == start` : épisode ignoré (durée nulle).

---

## D. Soins & santé

| # | KPI | Définition exacte |
|---|---|---|
| D1 | **Température** | dernière valeur + **max** sur la période ; **alerte** si ≥ 38,0 °C |
| D3 | **Bains** | nombre sur la période |
| D4 | **Médicaments** | liste horodatée (nom + heure) sur la période |

> ~~D2 temps sur le ventre~~ et ~~D5 soins (yeux/nez/cordon)~~ : **écartés** (pas besoin —
> décision 2026-08-11).

- **Vitamine D volontairement écartée** des indicateurs : c'est un geste quotidien
  systématique, sans intérêt de tendance. (La case reste dans « Suivi ».)

---

## E. Qualité des données (garant de la précision + export propre)

Un encart discret « Qualité des données » liste les anomalies détectées, chacune
cliquable pour corriger l'événement :

- couche **sans contenu** renseigné (`couchesSansType`) ;
- tétée **sans côté** (`teteesSansCote`, pour l'équilibre) ;
- **dodo non terminé** démarré il y a > 16 h (`dodosNonFermes`, probable oubli de « fin ») ;
- **durée négative** (`dureesNegatives`, réveil avant coucher) ;
- **dodo de durée improbable** ≥ 16 h bien que clos (`dureesAberrantes`) ;
- **dodo qui chevauche le précédent** (`dodosChevauchants`, même sieste saisie 2 fois) ;
- température **hors plage plausible** (`tempHorsPlage`, < 34 ou > 42 °C).

Règles de l'encart :

- **Portée = la fenêtre affichée** (7/14/30 j), pour *tous* les domaines : l'encart
  décrit ce que montrent les cartes du dessus, pas tout l'historique.
- Listes triées du **plus récent au plus ancien** (comme le journal) : l'ordre ne
  dépend jamais de l'ordre d'arrivée des événements.
- Chaque ligne est **tapable** et ouvre l'édition de l'événement fautif.

Ces points ne sont pas des erreurs de calcul mais des **trous/erreurs de saisie** ;
les exposer évite qu'une stat « fausse » passe inaperçue et fiabilise l'export IA.
Corollaire : tout type d'anomalie produit par `stats.js` **doit** avoir sa ligne dans
l'encart, sinon l'anomalie serait muette (garde automatisée, §J).

---

## F. Affichage — vue « Stats » (nouvel onglet 📊)

Onglet placé en **3ᵉ position, après « Suivi » et « Appris »** (`VIEWS` : suivi, appris,
stats) — les stats sont consultées ponctuellement, la saisie reste l'onglet d'entrée.

### Structure (mobile-first, minimaliste)

1. **Sélecteur de période** en haut : `7 j` / `14 j` / `30 j` (défaut 7 j).
2. **Bandeau « Aujourd'hui »** : les chiffres bruts du jour en cours (repas, part du
   biberon, sommeil, pipis/cacas), libellé « à cette heure ». **Pas de flèche de
   tendance** ni de comparaison à la moyenne : le jour est partiel, une comparaison
   serait trompeuse. Les moyennes vivent sur les cartes (jours complets uniquement).
3. **Cartes essentielles** (les 6 qui comptent au quotidien), chacune =
   - un grand chiffre (moyenne /jour sur la période, ou valeur du jour),
   - un sous-libellé,
   - un **mini graphe** = une valeur par jour sur la période (sparkline).

   Cartes retenues :
   1. **Sein vs Biberon /j** ★ (barres empilées tétées/biberons) — carte large en tête
   2. **Part du biberon %** ★ (courbe de tendance vers 100 %)
   3. **Volume bu /j** (ml)
   4. **Sommeil total /j**
   5. **Plus long sommeil**
   6. **Pipis /j** & **Cacas /j** (deux compteurs, une carte)
4. **Section « Détails »** repliée : A5 (intervalles), A6/A7 (durée & côtés),
   B4 (intervalle moyen entre 2 cacas), D1 (température), D3 (bains), D4 (médicaments).
5. **Encart Qualité des données** (§E) **repliable** (fermé par défaut, comme Détails),
   avec un badge du nombre d'anomalies ; masqué si aucune.
6. **Bouton Export** en bas (voir §G).

### Règles visuelles

- Palette et style des tuiles existantes réutilisés (une couleur par domaine :
  tétée/biberon, couche, sommeil, soins). Charte de dataviz appliquée à la
  construction (barres, axes, contraste clair/sombre) au moment du code.
- Barres = valeur par jour ; aujourd'hui (jour partiel) **hachuré/atténué** pour
  ne pas induire en erreur.
- Aucune animation superflue ; lecture instantanée.

*(Alternative écartée : une simple section sous « Suivi ». Un onglet dédié garde la
page Suivi épurée et laisse de la place aux graphes.)*

---

## G. Export & exhaustivité (pour analyse / IA)

La base contient **déjà tout** au niveau brut (jsonb). L'export propose 3 formats,
depuis la vue Stats :

1. **JSON brut** (fidélité totale) : liste complète des événements + en-tête méta
   `{ exported_at, timezone, app_version, schema_version, includes_deleted }`.
   Option « inclure les supprimés » (tombstones) pour un audit complet.
2. **CSV événements** (1 ligne = 1 événement), colonnes typées et **aplaties** :
   `id, action, ts_utc, date_local, time_local, tz_offset_min, side, duration_min,`
   `volume_ml, couche_type, is_pee, is_poop, temp_c, med_name, sleep_end_utc,`
   `sleep_duration_min, deleted, updated_at`.
   → format idéal pour donner « tel quel » à une IA.
3. **CSV agrégat quotidien** (1 ligne = 1 jour civil), colonnes = tous les KPI /jour :
   `date, partiel, repas, tetees, biberons, volume_ml, part_biberon_pct, sommeil_min,`
   `plus_long_sommeil_min, nb_dodos, pipis, cacas, couches, temp_max_c`.
   → **le format le plus adapté à l'évolution dans le temps et à la prédiction.**
   `partiel=1` pour aujourd'hui et le jour de naissance (à exclure des moyennes). Les
   colonnes couche/sommeil sont **vides** (jamais `0`) tant que le domaine n'est pas
   fiable (avant le 11 août) — pour ne pas induire l'analyse/IA en erreur.

### Recommandations d'exhaustivité en base (optionnel, à décider)

- **`created_at` immuable** (défaut serveur, jamais modifié) distinct de `ts`
  (heure de l'événement, éditable) : permet à une IA de distinguer « quand c'est
  arrivé » de « quand ça a été saisi ». Faible coût, forte valeur analytique.
- **Auteur / appareil** (quel parent a saisi) : intéressant (« qui gère les nuits »)
  mais ajoute de la friction → probablement **hors périmètre** pour l'instant.
- **Mesures de croissance** (poids, taille, périmètre crânien) : **non captées
  aujourd'hui**. C'est LA donnée « évolution dans le temps » de référence en
  pédiatrie et la plus utile pour une courbe/prédiction IA. Proposition : nouveau
  type `mesure` `{ weight_g?, height_cm?, head_cm? }` saisi ponctuellement
  (pesée hebdo, visites). Change la capture → à valider séparément.

---

## H. Découpage de mise en œuvre (proposé)

1. **Couche calcul pure** `Stats.*` : fonctions pures event[] → KPI, avec toutes les
   règles §0 (jour local, découpe minuit, jour partiel, champs manquants). **Testée**
   sur des jeux de données incluant les cas limites (minuit, dodo en cours, champs
   absents) avant tout affichage — c'est là que se joue la précision (→ **§J**).
2. **Vue Stats** (onglet, période, cartes + sparklines, bandeau du jour).
3. **Section détails + encart qualité des données.**
4. **Export** JSON + 2 CSV.
5. *(optionnel, si validé)* `created_at` en base + type `mesure` croissance.

---

## I. Décisions (validées le 2026-08-11)

1. **Sommeil** : ✅ **découpe à minuit** pour le total /jour.
2. **Croissance (poids/taille)** : ❌ **non** pour l'instant (réévaluable plus tard).
3. **`created_at` immuable** en base : ✅ **oui** (finesse d'export IA).
4. **Cartes** : Vitamine D **retirée** (geste quotidien systématique). Priorité
   produit = **évolution sein vs biberon** (transition vers le tout-biberon) → cartes
   « Sein vs Biberon /j » + « Part du biberon % » en tête (voir §A, §F).
5. **Période par défaut** : 7 jours (bascule 14/30).
6. **KPI écartés** : C4 (jour/nuit), D2 (temps sur le ventre), D5 (soins yeux/nez/cordon)
   — pas besoin.
7. **Placement** : onglet Stats en **3ᵉ position** (après Suivi et Appris).
8. **Fiabilité des données** (voir §0.9) : `repas` depuis la naissance (6 août, jour
   partiel exclu des moyennes) ; `couches`/`sommeil` fiables **à partir du 11 août 2026**.
   Avant, « pas de donnée » (jamais un zéro).
9. **Épisodes de sommeil impossibles** (validé le 2026-08-13, avant le prédictif) :
   dodo clos ≥ 16 h et dodos qui se chevauchent → **signalés seulement**, jamais
   filtrés ni fusionnés (voir §0.3). Les stats descriptives sont le reflet exact du
   journal ; le prédictif, lui, écartera ces épisodes.

---

## J. Tests unitaires (`tests/`)

```bash
node tests/run.js          # tout
node tests/run.js stats    # une seule famille de fichiers
```

Zéro dépendance, zéro build (comme le reste du dépôt) : un harnais de ~90 lignes
(`tests/run.js`) + des fichiers `*.test.js`. Deux précautions qui évitent les faux verts :

- le harnais **se relance lui-même avec `TZ=Europe/Paris`** — toutes les frontières de
  jour et les tests d'heure d'été en dépendent ;
- `stats.js` est chargé **tel quel** (`eval` + `const Stats` → `global.Stats`) : on teste
  le fichier livré, sans copie ni adaptation qui pourrait diverger.

### Couverture

| Fichier | Ce qui est verrouillé |
|---|---|
| `stats.test.js` §1 | Résolution et découpe des épisodes : cas de référence 22h30→02h (90/120), épisode sur 3 jours, dodo en cours, bornes 15,9/16/16,1 h, `end<start`, `end==start`, `end` illisible, `data` absente, dodo de 40 s, invariant Σ segments = `totalMin`, tri et chevauchements de `sleepEpisodes` (y compris un épisode **englobé**) |
| `stats.test.js` §2 | Agrégats par jour sur une **journée réaliste** complète, valeur par valeur ; jour majoritaire de C2 (et l'égalité) ; tombstones, checklist et « appris » non comptés ; hors fenêtre ignoré mais nuit qui **déborde dans** la fenêtre comptée ; jour partiel ; champs illisibles |
| `stats.test.js` §3 | Dénominateurs des moyennes (`complete && tracked && dataX`), domaine antérieur à sa date de fiabilité, jour de naissance, aujourd'hui exclu des moyennes mais inclus dans les ratios, `les deux` = 50/50, intervalles repas/cacas à cheval sur minuit, `tempAlert`, tri des médicaments |
| `stats.test.js` §4 | Les 7 types d'anomalies, les bornes 34/42 °C, dodos jointifs (≠ chevauchement), **portée fenêtre** et **tri** des listes |
| `stats.test.js` §5 | Fuseau, `daysWindow`, nuit de 25 h (1500 min) et de 23 h (90+180), agrégat autour d'un changement d'heure, comptage de jours civils en `Math.round` |
| `stats.test.js` §6 | **Propriétés sur 200 scénarios** (PRNG déterministe, graine fixe) : aucune valeur non finie, minutes/dodos par jour recalculés par un **second algorithme**, ≤ 1440 min hors chevauchement, chaque moyenne dans `[min, max]` de ses jours, résultat **indépendant de l'ordre** d'entrée et idempotent |
| `guards.test.js` §7 | Gardes sur les sources : **aucun bloc de démo**, `CACHE` du SW = max des `?v=N` et `ASSETS` ≡ URLs versionnées d'`index.html`, division par un jour en ms toujours en `Math.round`, version d'export dérivée de l'asset, `domainStart`/`firstCompleteDay` bien passés, découpe à minuit non dupliquée, `stats.js` pur et surface publique stable, chaque anomalie affichée |

### Hors périmètre (assumé)

- **Synchro `Store`/Supabase** : couplée à `localStorage` + réseau, non testable sans
  extraction préalable. Les tests garantissent que *si* le journal est correct, les
  calculs le sont ; pas que la synchro livre le bon journal.
- **Rendu UI** : vérifié à la main en preview (les gardes §7 couvrent les régressions
  mécaniques : cache périmé, anomalie muette).
- **Repas en double** (deux parents notant la même tétée) : contrairement au sommeil, un
  chevauchement n'y est **pas** physiquement impossible → aucune heuristique fiable, donc
  aucune détection (ce serait de faux positifs).

### Règle de travail

Toute correction de calcul commence par **un test qui échoue**, et toute règle modifiée
est mise à jour **ici et dans les tests** en même temps. Vérifier de temps en temps que
la suite est encore mordante en cassant volontairement une règle (round → floor, seuil
16 h → 20 h…) : au moins un test doit rougir.
