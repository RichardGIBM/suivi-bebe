# Specs — Vue « Frise » du journal (timeline temporelle)

> Objectif : offrir, dans le journal, une **bascule Liste ↔ Frise**. La frise
> montre les événements du jour **sur un axe de 24 h**, pour une lecture
> **« en un coup d'œil »** (quand bébé a dormi, mangé, été changé…), là où la
> liste reste la vue de saisie/détail chronologique.
>
> Réf. visuelle fournie par l'utilisateur : une frise horizontale d'une app
> concurrente (« moche mais l'esprit général »). On en garde **l'idée** (24 h
> horizontal, sommeil en barre, événements posés à leur heure) et on **corrige
> le défaut principal** : tout est empilé sur une seule ligne → illisible dès
> qu'il y a du volume.
>
> Statut : **spec (à valider)** — mockup front-only d'abord, puis intégration.

---

## 0. Principe directeur

La frise est une **vue de lecture**, pas une nouvelle source de données : elle
consomme le **même journal d'événements** que la liste (`Store.byDay(date)`),
sans rien stocker de dérivé. Toucher une marque ouvre **la même feuille
d'édition** que la liste (`openEditSheet`). Corriger un événement met à jour les
deux vues. Pas de double vérité.

**Décision d'orientation — horizontal, pas vertical (agenda).**
La réf. est horizontale et l'objectif est « le jour entier d'un coup d'œil, sans
scroller ». Une frise verticale type agenda montre mieux le détail mais oblige à
scroller → on perd le coup d'œil. On retient donc l'**axe horizontal 24 h**.

**Décision de mise en page — lanes par domaine (le vrai gain vs la réf.).**
Au lieu d'une ligne unique où tout s'empile, on empile **des pistes (lanes)
horizontales, une par domaine**. Chaque domaine a sa couleur (palette existante)
et sa piste dédiée → plus de chevauchement chaotique, densité gérée, lecture
immédiate.

---

## 1. Bascule Liste ↔ Frise

- **Segmented control** dans l'en-tête de la section « Journal », à droite du
  titre : `Liste` | `Frise` (2 segments, l'actif surligné).
- **Défaut = Liste** (comportement actuel, non régressif).
- **Préférence mémorisée** en `localStorage` (`suivi-bebe-journal-view`) →
  l'utilisateur retrouve sa vue au rechargement.
- N'affecte **que** la section Journal ; le reste de l'onglet Suivi est inchangé.
- La bascule fonctionne aussi sur les **jours passés** (via les flèches de date
  existantes).

---

## 2. Structure de la frise

Un axe **horizontal de 0 h à 24 h** (jour civil local, cohérent avec le reste de
l'app), carte pleine largeur.

1. **Axe temps** (en haut) : graduations toutes les **3 h** (0·3·6·9·12·15·18·21·24),
   libellées, discrètes ; fines lignes verticales de grille derrière les lanes.
2. **Bande nuit** : fond légèrement teinté sur ~**20 h → 7 h** (repère jour/nuit
   sans surcharge d'icônes). Petits glyphes 🌙 / ☀️ discrets sur l'axe (clin d'œil
   à la réf., facultatif).
3. **Ligne « maintenant »** : trait vertical marqué à l'heure courante —
   **uniquement si le jour affiché est aujourd'hui**. La portion de piste
   **après** « maintenant » est atténuée (futur non advenu).
4. **Lanes par domaine** (ordre proposé), chacune = puce couleur + icône à
   gauche, piste à droite :
   1. **Repas** 🍼 — tétées + biberons
   2. **Sommeil** 😴 — épisodes de sommeil
   3. **Couches** 🧷 — pipi / caca / mixte
   4. **Soins** — bain 🛁 / température 🌡️ / médicament 💊
   - Une lane **sans événement** ce jour-là est affichée **atténuée** (ou masquée —
     à trancher pendant l'itération ; défaut : atténuée pour garder la structure
     stable).

---

## 3. Marques (charte dataviz appliquée)

- **Événements instantanés** (tétée, biberon, couche, bain, température,
  médicament) = **pastille ronde** portant l'icône, posée à son heure.
- **Événements à durée** (sommeil) = **barre arrondie** (coins 4 px), largeur =
  durée, ancrée à l'axe ; gap de 2 px si barres adjacentes. Si assez large, la
  **durée** est écrite dans la barre.
- **Cible tactile ≥ 32 px** même si le visuel est plus petit (zone de tap élargie).
- **Couleur = palette existante** (une couleur par domaine). L'**identité n'est
  jamais portée par la couleur seule** : lane (position) + icône + libellé la
  portent → robuste au daltonisme. Les lanes sont séparées par un léger fond
  alterné pour que deux domaines de teinte proche (sommeil/couches, tous deux
  verts) restent distincts par la **ligne**, pas la couleur.
- **Grille et axe récessifs** ; aucune animation superflue.

---

## 4. Densité & collisions

- Les lanes suppriment l'empilement inter-domaines. **Dans** une lane, si deux
  marques se chevauchent (repas rapprochés) : léger décalage horizontal, et au
  besoin regroupement avec un petit compteur « ×2 » (tap → détail).
- Objectif nourrisson réaliste : ~8–12 repas, ~10 couches, plusieurs dodos/jour →
  doit rester lisible.

---

## 5. Interaction

- **Tap sur une marque** → `openEditSheet(ev)` (même feuille que la liste :
  édition complète, suppression).
- **Tap sur une barre de sommeil** → édition de l'épisode (coucher/réveil).
- Pas de zoom/scroll en v1 (fenêtre fixe 24 h).

---

## 6. États limites (précision, cohérente avec les stats)

- **Journée vide** : même message que la liste (« Aucune action enregistrée ce
  jour. »).
- **Jour passé** (pas aujourd'hui) : pas de ligne « maintenant », pas
  d'atténuation du futur (le jour est complet).
- **Sommeil à cheval sur minuit** : borné à l'axe **0/24 du jour affiché** (la
  portion de la veille/lendemain appartient à l'autre jour) — cohérent avec la
  découpe à minuit des stats.
- **Sommeil en cours** (`end:null`) : barre jusqu'à « maintenant », extrémité
  **ouverte** (dégradé / hachure) pour signaler « pas terminé ».
- **Durée négative** (`end < start`) : bornée à 0 (marque ponctuelle) — déjà
  signalée en Qualité des données côté stats.

---

## 7. Accessibilité / responsive

- **Mobile-first** : carte pleine largeur ; hauteur ≈ (nb lanes × ~34 px) + axe.
- Puces de lane = **légende implicite** (icône + couleur + libellé à gauche).
- La **vue Liste sert d'alternative textuelle** (équivalent « table » de la
  charte dataviz : tout est lisible en toutes lettres dans l'autre vue).
- Contraste des libellés d'axe/heure : encre douce mais lisible (jamais la
  couleur d'un domaine sur du texte).

---

## 8. Hors périmètre v1 (pistes futures)

- **Prévisions** : marques pointillées « prochain repas / prochain dodo » (comme
  les cases pointillées de la réf.) → **v2**, nécessite un petit modèle de
  prédiction (rythme moyen). Non inclus au premier mockup.
- Fenêtre < 24 h avec zoom/scroll ; frise **multi-jours** (semaine).
- Marqueurs de température en alerte (pastille rouge) — à décider.

---

## 9. Itération (ce qu'on fait maintenant)

1. **Mockup front-only** `mockup-timeline.html` : fausses données d'une journée
   réaliste, la bascule Liste/Frise, la frise à lanes complète (axe, nuit, now,
   pastilles, barres de sommeil). **But : valider le look** avant de toucher à
   l'app.
2. Itérations visuelles sur le mockup (couleurs, hauteurs, densité, ordre des
   lanes, glyphes jour/nuit…).
3. **Intégration** une fois validé : bascule dans `index.html` (en-tête Journal),
   `renderJournalTimeline()` dans `app.js` (à côté de `renderTimeline()` renommé
   `renderJournalList()`), styles dans `styles.css`, bump de version + SW.

---

## 10. Décisions à valider avec l'utilisateur (pendant l'itération)

1. **Orientation** : horizontal 24 h (proposé) vs vertical agenda.
2. **Lanes vides** : atténuées (proposé) vs masquées.
3. **Ordre des lanes** : Repas / Sommeil / Couches / Soins (proposé).
4. **Fenêtre** : 24 h fixe (proposé) vs adaptative (premier→dernier événement).
5. **Prévisions pointillées** : v2 ou tout de suite ?
