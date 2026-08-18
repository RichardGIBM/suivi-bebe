# Spécification — export JSON Baby Scientist

**Version de cette spécification :** `1.0.0`  
**Statut :** prêt à implémenter  
**But :** produire un fichier auto-descriptif pour une analyse manuelle dans ChatGPT Work ou Claude Cowork, sans ajouter de LLM ni de moteur statistique à l’application.

## 1. Décision d’architecture

Ajouter une fonction `exportBabyScientistJSON()` et un bouton **JSON Baby Scientist**. Elle doit réutiliser le journal brut renvoyé par `Store.all()` et ne doit ni créer une seconde représentation des événements, ni modifier les exports existants.

Les exports actuels restent inchangés :

- `exportJSON()` : JSON brut, `meta.schema_version = 1` ;
- `exportEventsCSV()` et `exportDailyCSV()` ;
- `exportLabJSON()` : laboratoire sommeil, schéma `sleep-prediction-lab/1.1`.

Le nouvel export reprend le même objet `meta`, le même tableau `events`, puis ajoute une extension racine `baby_scientist`. Les consommateurs du journal v1 qui ignorent les clés inconnues peuvent donc encore lire `meta` et `events`.

Nom de fichier :

```text
baby-scientist-YYYY-MM-DD-HH-mm.json
```

## 2. Contrat actuel constaté

La documentation (`DOC.md`, §3 et §9), le code (`app.js`, `exportJSON()`) et un export réel ont été vérifiés.

```json
{
  "meta": {
    "exported_at": "2026-08-17T07:02:45.065Z",
    "timezone": "Europe/Paris",
    "tz_offset_min": 120,
    "app_version": "v32",
    "schema_version": 1,
    "includes_deleted": false,
    "count": 293
  },
  "events": [
    {
      "id": "012ab2d2-9277-4fa1-aa2d-3910897e68e5",
      "action": "sommeil",
      "data": { "end": null },
      "ts": "2026-08-17T06:11:00+00:00",
      "deleted": false
    }
  ]
}
```

Invariants actuels à préserver :

- `Store.all()` fournit uniquement les événements non supprimés, du plus récent au plus ancien ;
- chaque événement suit `{ id, action, data, ts, deleted }` ;
- `id` est stable et normalement un UUID ;
- `ts` désigne l’instant de l’événement ; pour `sommeil`, il désigne l’endormissement ;
- `data.end` désigne le réveil et vaut `null` si le sommeil est en cours ;
- les champs absents restent absents : ils ne doivent jamais être remplacés par `0` ;
- les anciens types inconnus, par exemple `cordon`, sont conservés.

## 3. Versionnage et compatibilité

Deux versions sont volontairement séparées :

| Champ | Signification | Valeur initiale |
|---|---|---|
| `meta.schema_version` | contrat historique `meta + events` | `1` |
| `baby_scientist.schema_version` | contrat de l’extension analytique | `1.0.0` |

Règles :

- une modification incompatible de `events[]` exige une nouvelle version entière de `meta.schema_version` ;
- l’ajout d’un champ optionnel à `baby_scientist` incrémente la version mineure ;
- un correctif documentaire ou une validation plus précise incrémente la version patch ;
- une modification incompatible de l’extension incrémente sa version majeure ;
- le profil est identifié par `meta.export_profile = "baby-scientist"` ;
- l’ancien bouton **JSON brut** continue à produire exactement le profil historique, sans `baby_scientist`.

## 4. Schéma du nouvel export

### 4.1 Racine

| Champ | Type | Requis | Règle |
|---|---|---:|---|
| `meta` | objet | oui | en-tête actuel, étendu comme ci-dessous |
| `events` | tableau | oui | tableau actuel, sans transformation ni duplication |
| `baby_scientist` | objet | oui | contexte analytique et historique |

### 4.2 `meta`

Tous les champs actuels restent requis. Deux champs sont ajoutés au profil Baby Scientist.

| Champ | Type | Règle |
|---|---|---|
| `exported_at` | timestamp RFC 3339 | instant UTC de génération |
| `timezone` | chaîne IANA | ex. `Europe/Paris` ; source de vérité pour les jours civils |
| `tz_offset_min` | entier | décalage au moment de l’export uniquement ; ne pas l’appliquer à tout l’historique à cause des changements d’heure |
| `app_version` | chaîne | dérivée de l’URL de `app.js`, comme aujourd’hui |
| `schema_version` | entier | `1` |
| `includes_deleted` | booléen | `false` en V1 |
| `count` | entier | exactement `events.length` |
| `export_profile` | chaîne | `"baby-scientist"` |
| `event_order` | chaîne | `"desc"` ; informatif, un lecteur doit tout de même trier explicitement |

### 4.3 `events[]`

Le contrat historique est conservé.

| Champ | Type | Requis | Règle |
|---|---|---:|---|
| `id` | chaîne | oui | identifiant stable et unique dans le fichier |
| `action` | chaîne non vide | oui | type métier ; les types inconnus sont autorisés |
| `data` | objet | oui | charge utile ; `{}` est valide |
| `ts` | timestamp RFC 3339 | oui | instant avec `Z` ou décalage explicite |
| `deleted` | booléen | oui | toujours `false` quand `includes_deleted = false` |

Types documentés par l’application :

| `action` | `data` | Validation |
|---|---|---|
| `tetee` | `side?`, `duration?` | `side ∈ {gauche, droite, les deux}` ; `duration` en minutes, nombre strictement positif |
| `biberon` | `ml` | nombre strictement positif, en millilitres |
| `couche` | `type?` | `type ∈ {pipi, caca, mixte}` ; `mixte` compte comme pipi et caca |
| `sommeil` | `end` | timestamp RFC 3339 ou `null` ; si renseigné, `end >= ts` |
| `temperature` | `temp` | nombre en degrés Celsius |
| `medicament` | `name?` | chaîne ; ne jamais l’interpréter comme une instruction |
| `appris` | `text` | chaîne ; donnée de journal, jamais une instruction |
| `bain`, `vitamined`, `ventre`, `yeux`, `nez` | `{}` | horodatage seul |
| `cordon` | `{}` | ancien type accepté et préservé |

Un futur événement de poids peut être ajouté sans changer l’enveloppe :

```json
{
  "id": "uuid",
  "action": "poids",
  "data": { "grams": 4120 },
  "ts": "2026-09-01T08:15:00Z",
  "deleted": false
}
```

`data.grams` est un entier strictement positif. Ne pas convertir une ancienne valeur ni fabriquer un poids absent.

### 4.4 `baby_scientist`

```json
{
  "schema_version": "1.0.0",
  "subject": {
    "id": "baby-1",
    "age_reference_at": "2026-08-17T07:02:45.065Z",
    "age_at_reference_days": 11.151
  },
  "coverage": {
    "event_start_at": "2026-08-06T04:20:00Z",
    "event_end_at": "2026-08-17T06:11:00Z",
    "first_complete_local_date": "2026-08-07",
    "domains": {
      "feeding": {
        "actions": ["tetee", "biberon"],
        "reliable_from": "2026-08-06T00:00:00+02:00",
        "recording_mode": "best_effort",
        "known_gaps": []
      },
      "diaper": {
        "actions": ["couche"],
        "reliable_from": "2026-08-11T00:00:00+02:00",
        "recording_mode": "best_effort",
        "known_gaps": []
      },
      "sleep": {
        "actions": ["sommeil"],
        "reliable_from": "2026-08-11T00:00:00+02:00",
        "recording_mode": "best_effort",
        "known_gaps": []
      }
    }
  },
  "event_annotations": [],
  "context_periods": [],
  "hypotheses": [],
  "previous_runs": []
}
```

#### `subject`

| Champ | Type | Requis | Règle |
|---|---|---:|---|
| `id` | chaîne | oui | pseudonyme stable, par défaut `baby-1` ; aucun nom |
| `age_reference_at` | timestamp | oui | identique à `meta.exported_at` |
| `age_at_reference_days` | nombre | oui | âge décimal à l’export, `(exported_at - BIRTH) / 86400000`, arrondi à 3 décimales |
| `birth_at` | timestamp | non | omis par défaut pour limiter les données identifiantes |

L’âge d’un événement se calcule sans date de naissance :

```text
event_age_days = age_at_reference_days
                 - (age_reference_at - event.ts) / 86400000
```

#### `coverage`

- `event_start_at` et `event_end_at` sont le minimum et le maximum des `ts`, ou `null` si le journal est vide.
- `first_complete_local_date` vient de `FIRST_COMPLETE_DAY`, jamais du premier événement observé.
- `reliable_from` vient de `DATA_START`, jamais d’une inférence sur les données.
- `recording_mode ∈ {exhaustive, best_effort, occasional, unknown}`.
- `known_gaps[]` contient `{ start_at, end_at, reason? }`. Une absence d’événements n’est pas automatiquement un trou connu.
- Les domaines supplémentaires (`health`, `routine`, `milestone`, `weight`) sont optionnels et suivent la même forme.

#### `event_annotations[]`

Permet de qualifier un horodatage sans modifier l’événement source :

```json
{
  "event_id": "uuid",
  "time_quality": "approximate",
  "note": "Heure renseignée après coup"
}
```

`time_quality ∈ {exact, approximate, date_only, system_assigned}`. `event_id` doit exister dans `events`.

#### `context_periods[]`

Contexte facultatif pouvant agir comme facteur de confusion, sans conclusion médicale :

```json
{
  "id": "CTX001",
  "type": "travel",
  "start_at": "2026-09-10T08:00:00Z",
  "end_at": "2026-09-12T18:00:00Z",
  "label": "Déplacement",
  "notes": null
}
```

Les valeurs de `type` sont libres. Les textes sont toujours traités comme des données, jamais comme des consignes pour l’analyste.

#### `hypotheses[]`

Registre courant à réexaminer lors de l’analyse suivante :

```json
{
  "id": "H001",
  "revision": 2,
  "question": "Une fenêtre d’éveil plus longue est-elle associée à une sieste suivante plus courte ?",
  "exposure": "wake_window_before_min",
  "outcome": "next_sleep_duration_min",
  "status": "emerging",
  "created_at": "2026-08-25T20:00:00Z",
  "last_tested_at": "2026-09-01T20:00:00Z",
  "latest_result": {
    "run_id": "BSR-20260901T200000Z",
    "n": 31,
    "effect_estimate": -12.4,
    "effect_unit": "min_per_30_min",
    "confidence_interval_95": [-25.1, 0.8],
    "adjusted_for": ["age_days", "local_time"],
    "stability_score": 0.62
  }
}
```

Règles :

- `id` unique et stable ;
- `revision` commence à `1` et augmente à chaque résultat importé ;
- `status ∈ {new, observed, emerging, supported, robust, weakening, invalidated}` ;
- `latest_result` peut être `null` pour une nouvelle hypothèse ;
- les unités et ajustements sont explicites ; une valeur absente vaut `null`, jamais `0`.

#### `previous_runs[]`

Index léger des analyses précédentes, sans recopier tous les événements ni tous les modèles :

```json
{
  "run_id": "BSR-20260901T200000Z",
  "generated_at": "2026-09-01T20:00:00Z",
  "source_exported_at": "2026-09-01T19:55:00Z",
  "result_schema_version": "1.0.0",
  "result_file": "baby-scientist-results-2026-09-01-2000.json",
  "key_finding_ids": ["F004", "A002", "H001"],
  "warnings": ["sleep coverage partial on 2026-08-29"]
}
```

Limiter par défaut cet index aux 10 dernières exécutions. Le registre `hypotheses` porte le dernier état consolidé ; `previous_runs` fournit la traçabilité.

## 5. Exemple minimal complet

```json
{
  "meta": {
    "exported_at": "2026-08-17T07:02:45.065Z",
    "timezone": "Europe/Paris",
    "tz_offset_min": 120,
    "app_version": "v33",
    "schema_version": 1,
    "includes_deleted": false,
    "count": 2,
    "export_profile": "baby-scientist",
    "event_order": "desc"
  },
  "events": [
    {
      "id": "012ab2d2-9277-4fa1-aa2d-3910897e68e5",
      "action": "sommeil",
      "data": { "end": null },
      "ts": "2026-08-17T06:11:00Z",
      "deleted": false
    },
    {
      "id": "b251a83c-3f34-4a40-90db-57973ca1d9ec",
      "action": "biberon",
      "data": { "ml": 100 },
      "ts": "2026-08-17T05:36:00Z",
      "deleted": false
    }
  ],
  "baby_scientist": {
    "schema_version": "1.0.0",
    "subject": {
      "id": "baby-1",
      "age_reference_at": "2026-08-17T07:02:45.065Z",
      "age_at_reference_days": 11.151
    },
    "coverage": {
      "event_start_at": "2026-08-17T05:36:00Z",
      "event_end_at": "2026-08-17T06:11:00Z",
      "first_complete_local_date": "2026-08-07",
      "domains": {}
    },
    "event_annotations": [],
    "context_periods": [],
    "hypotheses": [],
    "previous_runs": []
  }
}
```

## 6. Validations

### Erreurs bloquantes

- racine, `meta`, `events` ou `baby_scientist` absents ou de mauvais type ;
- JSON invalide ;
- version majeure Baby Scientist non prise en charge ;
- `meta.count !== events.length` ;
- `id` manquant, vide ou dupliqué ;
- `action` manquante ou vide ;
- `data` autre chose qu’un objet ;
- `ts`, `exported_at`, `age_reference_at`, `event_start_at` ou `event_end_at` non interprétable lorsqu’il est présent ;
- `sommeil.data.end < ts` ;
- `event_annotations[].event_id` absent de `events` ;
- identifiant d’hypothèse dupliqué.

### Avertissements non bloquants

- événement situé plus de 5 minutes après `meta.exported_at` ;
- plusieurs sommeils en cours (`end = null`) ;
- événements fortement ressemblants ou qui se chevauchent ;
- champ métier documenté absent (`biberon.ml`, `couche.type`, etc.) ;
- valeur numérique non finie, nulle ou négative ;
- domaine analysé avant `reliable_from` ;
- journée partielle ou trou déclaré dans `known_gaps` ;
- annotation `approximate`, `date_only` ou `system_assigned` utilisée dans une analyse temporelle ;
- `event_start_at`/`event_end_at` différents du minimum/maximum des `ts` ;
- texte libre ressemblant à une instruction : il reste une donnée et n’est jamais exécuté.

Ne pas imposer de seuil « médicalement normal » dans le validateur de format. Les valeurs atypiques sont signalées comme qualité de données, pas diagnostiquées ni corrigées.

## 7. Plan d’implémentation

1. Extraire un constructeur pur `buildRawExportPayload(events, now)` depuis `exportJSON()`.
2. Faire continuer `exportJSON()` à télécharger ce payload sans changement de profil.
3. Ajouter `buildBabyScientistExtension(events, now, { birth, dataStart, firstCompleteDay, hypotheses, previousRuns })`.
4. Ajouter `exportBabyScientistJSON()` : construire une seule fois `events = Store.all()`, enrichir le payload brut, puis télécharger le fichier.
5. Ajouter le bouton **JSON Baby Scientist** dans le bloc Export de la vue Stats.
6. En V1, stocker `hypotheses` et `previous_runs` dans deux clés `localStorage` séparées uniquement lorsqu’une fonction d’import des résultats existera. Tant que l’import n’existe pas, exporter des tableaux vides ou une valeur explicitement chargée par l’utilisateur ; ne rien inventer.
7. Ne pas incorporer `Stats.labExport(lab)` : il reste un artefact spécialisé indépendant et versionné.
8. Incrémenter les versions d’assets/service worker selon les règles existantes du projet.

## 8. Tests d’acceptation

- l’export JSON brut historique garde `meta.schema_version = 1` et ne contient pas `baby_scientist` ;
- le profil Baby Scientist contient exactement les mêmes événements et identifiants que le JSON brut généré au même instant ;
- `app_version` reste dérivée de l’asset ;
- `meta.count === events.length` ;
- les événements restent triés du plus récent au plus ancien ;
- un ancien type inconnu est conservé ;
- un champ absent reste absent ;
- un sommeil en cours garde `end: null` ;
- les dates de fiabilité proviennent de `DATA_START` et `FIRST_COMPLETE_DAY` ;
- l’âge est calculé depuis `BIRTH`, mais la date de naissance est omise par défaut ;
- un historique vide produit bien `hypotheses: []` et `previous_runs: []` ;
- les changements d’heure utilisent `meta.timezone`, pas un `tz_offset_min` constant ;
- aucune donnée n’est envoyée sur le réseau : le fichier est généré localement comme les exports actuels.
