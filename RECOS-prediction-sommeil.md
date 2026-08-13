# Prédiction de sommeil — analyse de la proposition ChatGPT & recommandations

> Statut : **notes de réflexion / recommandations (à valider)** — rien n'est codé.
> Objectif : évaluer de façon critique la proposition reçue de ChatGPT sur la prédictivité
> de sommeil, et définir une version réaliste du **« Niveau 1 : statistiques
> personnalisées »** pour *cette* app précise — pas pour un produit générique à plusieurs
> bébés.

Méthode : au-delà de ma propre lecture du code (`app.js`, `stats.js`, `SPECS-stats.md`),
j'ai fait challenger la proposition sous quatre angles indépendants (rigueur statistique,
faisabilité technique réelle, UX pour un usage familial, périmètre/sur-ingénierie), puis
synthétisé en une spec concrète. Les quatre angles convergent sur les mêmes conclusions
par des chemins différents — c'est ce qui rend le résultat plus solide qu'un avis unique,
et c'est ce que je restitue ci-dessous en y ajoutant ma propre lecture.

> **Mise à jour du 13 août 2026.** Vous avez soumis ce document à ChatGPT, qui a renvoyé
> une contre-analyse pertinente sur plusieurs points statistiques (fenêtre glissante plutôt
> que pool cumulatif, médiane/IQR plutôt que moyenne/min-max, backtesting individuel comme
> mesure de qualité, recadrage du seuil d'âge comme choix produit) et proposé d'implémenter
> réellement le backtesting. J'ai fait vérifier cette contre-analyse de façon indépendante
> avant de l'intégrer (verdict : très largement solide, un trou identifié et refermé — voir
> §3.5). Le §1, le §2 et surtout le §3 ont été mis à jour en conséquence ; un nouveau §3.8
> répond à votre demande d'un 4e onglet « Prédiction » en mode laboratoire. Un mockup HTML
> séparé (`mockup-prediction.html`) accompagne cette mise à jour.
>
> **Mise à jour n°2, même jour.** Vous avez corrigé le cadrage : ce n'est pas seulement
> l'heure de réveil qui doit être prédite, mais **toute la plage de sommeil** —
> endormissement *et* réveil — et l'estimation d'éveil doit être convertie en heure
> d'endormissement plutôt que restée en simple durée. Ça implique un **second prédicteur**,
> jumeau du premier mais portant sur la durée de sommeil elle-même (§3.3), un mécanisme
> explicite pour chaîner les deux sans tricher statistiquement (§3.4), et deux backtests
> indépendants plutôt qu'un seul (§3.5-3.6). Vous avez aussi demandé une recommandation sur
> la fréquence de recalcul — réponse en §3.7, construite sur l'architecture réelle du code
> (vérifiée à nouveau, pas supposée). §3, §3.8-3.9 et §4 ont été mis à jour en conséquence ;
> `mockup-prediction.html` aussi.
>
> **Mise à jour n°3, même jour.** Vous avez tranché un point resté explicitement ouvert en
> décision n°4 du §4 et implicite dans tout le §3.1 : cette app est strictement
> personnelle, et vous, l'unique utilisateur, préférez voir un chiffre approximatif tôt
> plutôt qu'un mur d'attente pendant que le prédicteur mûrit — « je m'en fous de montrer
> des résultats trop tôt ». **Le gating d'affichage à quatre axes (âge, jours fiables,
> échantillons, backtests) est donc retiré.** Ce qui reste de ces quatre axes n'est plus
> qu'une information affichée en toute transparence à côté du chiffre, jamais une condition
> qui empêche de l'afficher — seule l'absence totale de donnée (n=0) reste un vrai blocage,
> parce que c'est une impossibilité mathématique, pas un choix de prudence. §1, §2, §3.1,
> §3.3-§3.6, §3.8-§3.9 et §4 sont réécrits en conséquence ; plusieurs constantes dont le nom
> impliquait un plancher d'affichage (`BACKTEST_MIN_N_DISPLAY` et consorts) sont renommées
> pour ne pas induire en erreur un lecteur qui n'aurait pas ce contexte. Vous avez aussi
> demandé que ce document se suffise à lui-même pour être remis à une autre instance sans
> historique de conversation (« une fork à qui je n'ai pas parlé de ça ») : d'où le nouveau
> **§0** ci-dessous, et une relecture complète pour éliminer les renvois implicites à cette
> conversation. `mockup-prediction.html` a été mis à jour à l'identique.

---

## 0. Pour l'implémenteur qui découvre ce document sans contexte

Ce document n'est pas un historique de conversation à lire dans l'ordre — c'est une spec.
Les blocs cités ci-dessus racontent comment on y est arrivé (utile pour comprendre certains
choix), mais si vous n'avez pas suivi les échanges qui l'ont produit, voici ce qu'il faut
savoir avant de lire le reste.

**Le projet.** Une PWA de suivi de bébé strictement personnelle (`app.js`, `stats.js`,
`styles.css`, `index.html` — pas de build, pas de framework, stockage `localStorage` + sync
Supabase entre 2 téléphones du même foyer, aucun autre utilisateur, aucun client externe à
protéger). Un seul bébé, né le **6 août 2026 à 5h25**. Le domaine `sommeil` est fiable
depuis le **11 août 2026** (`DATA_START.sommeil`, [app.js:328](app.js#L328)) — avant cette
date, les événements de sommeil existent peut-être dans les données mais ne sont pas dignes
de confiance et ne doivent pas entrer dans les calculs ci-dessous.

**Ce qu'on construit.** Un système qui prédit toute la plage de sommeil à venir — heure
d'endormissement **et** heure de réveil — à partir du seul historique personnel de ce bébé,
avec deux prédicteurs jumeaux chaînés l'un à l'autre (§3.2 endormissement, §3.3 réveil,
§3.4 le mécanisme de chaînage) et un backtesting silencieux qui mesure en continu leur
erreur réelle sur les épisodes passés (§3.5). Rien de tout ça n'utilise de librairie
statistique externe : médiane, quantiles (P25/P75) et comparaison d'erreurs en paires,
calculés à la main sur des tableaux JS. Côté interface : un 4e onglet dédié « Prédiction »
(§3.8), avec les textes exacts à utiliser en §3.9.

**La règle qui prime sur tout le reste de ce document : ne jamais rien cacher.** Une
version antérieure de cette spec imposait un système de portes (« gating ») qui bloquait
tout affichage tant que l'âge du bébé, le volume de données et la performance mesurée du
backtest n'avaient pas simultanément franchi des seuils élevés (56 jours, 14 jours civils,
20 échantillons récents, 40 backtests récents). **Cette logique de portes a été retirée**
(décision produit explicite : app strictement personnelle, l'utilisateur sait déjà que les
chiffres sont approximatifs et préfère les voir tôt). Si vous lisez plus loin et tombez sur
une formulation qui semble décrire un mur d'attente, un état « pas encore assez de recul »
qui masquerait un chiffre, ou un seuil qui empêcherait un affichage — c'est soit un résidu
qui a échappé à la relecture (signalez-le), soit un des deux planchers strictement
mathématiques suivants, qui ne sont *pas* des choix de prudence :
- **n = 0** (aucune donnée) : rien à afficher, littéralement impossible à calculer.
- **n < 3** : un chiffre central (médiane) s'affiche déjà, mais pas de plage — une plage
  empirique (P25/P75) sur 1 ou 2 points ne serait que les points eux-mêmes, pas une mesure.

En dehors de ces deux cas, tout ce qui est calculable **s'affiche**, accompagné d'un badge
de confiance continu et honnête (🌱 très approximatif / 🧪 encore incertain / ✅ plus
robuste — détail en §3.6) qui informe sans jamais remplacer le chiffre par un silence.

**Où regarder si vous codez à partir de ce document.** §3.2 et §3.3 pour les deux
prédicteurs (formules, fenêtres glissantes, constantes), §3.4 pour le chaînage des deux en
une plage de sommeil complète, §3.5 pour le mécanisme de backtesting silencieux, §3.6 pour
la règle d'affichage continu et les badges de confiance, §3.7 pour la cadence de recalcul
(quand recalculer, avec quel timer), §3.8-§3.9 pour l'UI concrète de l'onglet et les textes
français exacts à afficher à différents stades, §4 pour un résumé condensé et la liste
complète des constantes à ajouter à `stats.js`. Le fichier `mockup-prediction.html`, dans le
même dossier, est un HTML autonome (pas de dépendance à `app.js`/`stats.js`) qui montre
l'UI cible avec des données factices à trois stades de maturité différents (J7, ~3 semaines,
~9 semaines) — ouvrez-le dans un navigateur, c'est plus rapide à assimiler qu'à lire.

**Convention de nommage des constantes (pour lever toute ambiguïté avant de lire §3).**
Préfixe `WW_` = *Wake Window* (écart d'éveil, prédicteur 1, §3.2). Préfixe `SD_` = *Sleep
Duration* (durée de sommeil, prédicteur 2, §3.3) — **pas** « standard deviation » : l'écart-
type n'est utilisé nulle part dans ce document comme mesure de dispersion (explicitement
écarté en §3.11 au profit de la médiane/P25-P75) ; ne pas laisser la ressemblance visuelle
avec « SD = standard deviation » induire en erreur. Préfixe `RT_` = *Round-Trip* (le
diagnostic chaîné des deux prédicteurs, §3.4-3.5). `BACKTEST_*` sans autre préfixe = backtest
du prédicteur 1 (endormissement) ; `SD_BACKTEST_*` = backtest du prédicteur 2 (réveil).

---

## 1. Le fait qui change toute l'équation

La proposition de ChatGPT est écrite avec un cadrage implicite « produit » (plusieurs
bébés, dataset propriétaire, avantage compétitif) que vous avez vous-même écarté à juste
titre. Mais il y a un deuxième fait, plus concret et plus décisif, que la conversation
n'a pas assez pris en compte :

- Votre bébé est **né le 6 août 2026 à 5h25**. Aujourd'hui (13 août 2026), il a **7 jours**.
- Dans le code, le domaine `sommeil` n'est **fiable que depuis le 11 août 2026**
  (`DATA_START.sommeil`, [app.js:328-332](app.js#L328)) : vous avez donc **2 jours**
  de données de sommeil exploitables, pas « quelques jours » au sens flou de ChatGPT.
- Le seuil « 3–7 jours de logs » que ChatGPT propose pour le Niveau 1 est optimiste sur le
  volume. **Correction apportée à cette section** (la première version de ce document
  allait trop loin dans l'autre sens) : présenter l'absence de rythme circadien avant 6-8
  semaines comme un fait physiologique tranché était une sur-affirmation. Après
  vérification indépendante des sources, la rythmicité circadienne émerge **progressivement
  et de façon très variable d'un bébé à l'autre**, avec des signaux dès ~5 semaines chez
  certains nourrissons — ce n'est pas un interrupteur qui bascule net à J42 ni à J56.
  Preuve involontaire que ce type de chiffre a toujours été un curseur de prudence plutôt
  qu'une mesure : la première version de ce document citait déjà **deux** frontières «
  physiologiques » différentes pour le même bébé (42 jours pour la fenêtre d'éveil, 70-84
  jours pour une structure de sieste stable) — un vrai seuil biologique ne serait pas
  double. Ce qui reste vrai et suffit à justifier la prudence, sans exagérer : le sommeil
  néonatal reste piloté surtout par la faim (cycles ultradien de 2-4h) et très fragmenté
  dans les premières semaines. Le seuil d'âge retenu plus bas (§3.1) est donc redéfini
  explicitement comme **un choix de tolérance au risque produit, pas une frontière
  scientifique**.
- Signal intéressant : **vous avez déjà pris cette décision implicitement**. Le §C
  (Sommeil) de `SPECS-stats.md:125` écarte explicitement la distinction jour/nuit
  (« C4 jour vs nuit : écarté — pas besoin, décision 2026-08-11 »). La segmentation
  WW1/WW2/WW3 proposée par ChatGPT réintroduirait par la porte de derrière exactement la
  structure que vous avez déjà jugée non pertinente pour ce domaine.
- Argument externe qui corrobore tout ça : ChatGPT cite lui-même Huckleberry, qui réserve
  sa fonctionnalité de prédiction (SweetSpot) aux bébés de **2 mois et plus**, sans en
  tirer la conclusion logique pour sa propre proposition de Niveau 1 « dès 3-7 jours ».
  Si un produit avec des millions d'utilisateurs et une équipe data juge le signal trop
  faible avant 2 mois, une app perso avec 2 jours de données ne fera pas mieux.

**Conséquence directe** : à 7 jours et 2 jours de données de sommeil, tout ce que le
prédicteur produira dans les prochaines semaines sera **statistiquement bruité** — la
littérature et l'analogie Huckleberry ci-dessus donnent une bonne raison de s'attendre à ce
que le signal soit encore faible avant plusieurs semaines. Dans une version antérieure de ce
document, cette incertitude était traduite en un **seuil d'âge qui gate l'affichage**
(rien ne s'affiche avant 56 jours). **Ce choix a été explicitement écarté** (mise à jour
n°3, voir §0 et §3.1) : parce que c'est une app strictement personnelle et que l'incertitude
peut simplement être *dite* plutôt que *cachée*, l'affichage démarre dès qu'il y a au moins
un point de donnée — l'âge et le volume ne sont plus que du contexte informatif affiché à
côté du chiffre (§3.1), jamais une condition qui le remplace par un silence.

Le calcul, lui, démarre de toute façon dès aujourd'hui sans aucun coût ni aucun risque — et
sa propre mesure de qualité (backtesting, §3.5) est ce qui permet de savoir empiriquement,
pour *ce* bébé précis, à quel point chaque estimation est fiable à un instant donné, plutôt
que de deviner un âge dans la littérature.

---

## 2. Évaluation de la proposition, niveau par niveau

### Niveau 0 — règle déterministe par âge
**Ce qui tient** : le principe (toujours une fenêtre, jamais une heure ponctuelle) est
juste et cohérent avec la philosophie déjà en place dans `stats.js` (« pas de donnée »
plutôt qu'un zéro trompeur).
**Ce qui ne tient pas pour vous** : les plages de référence génériques par âge pour un
nourrisson de moins de 2 semaines sont énormes dans la littérature (souvent 45-90+ min).
Une fenêtre aussi large n'est pas actionnable, tout en donnant une **fausse impression de
personnalisation** (« estimé pour votre bébé » alors que c'est une moyenne de population
que vous n'avez même pas encore collectée). → **Ne pas construire comme feature séparée.**
Le pool personnel (Niveau 1 redéfini ci-dessous) le remplacera dès qu'il sera disponible ;
avant, mieux vaut n'afficher **rien** qu'un repère générique trompeur.

### Niveau 1 — statistiques personnalisées (celui que vous voulez implémenter)
C'est le cœur du document — voir §3 pour la version retenue. En bref, sur les trois
mécanismes proposés par ChatGPT :

| Mécanisme proposé | Verdict | Pourquoi |
|---|---|---|
| Fenêtre d'éveil personnalisée, présentée en plage | ✅ Gardé (principe) | Cohérent avec la philosophie du projet ; affichée dès qu'elle est calculable, avec un badge de confiance qui reflète le volume de données (voir §3.1) |
| Segmentation par indice de sieste (WW1/WW2/WW3) | ❌ Écarté | Présuppose une structure de sieste stable qui n'existe pas à 7 jours ; contredit la décision C4 déjà actée |
| EWMA à 3 termes (0,5×moy_3j + 0,3×moy_7j + 0,2×réf_âge) | ❌ Remplacé par une moyenne simple | Avec 2 jours de recul, « moy_3j » ≠ « moy_7j » : c'est un artefact de fenêtre tronquée, pas deux échelles de temps réelles. Les poids 0,5/0,3/0,2 n'ont aucune justification empirique donnée |
| Ajustement selon la sieste précédente (-12min/+14min) | ❌ Reporté | Chiffrage fictif présenté avec une précision qui n'existe pas ; nécessite ~30-40 paires avant de tester une corrélation |
| Score de confiance | ↺ Remplacé par une mesure de performance réelle (backtesting, §3.5-3.6) | Un pourcentage donnerait une fausse rigueur sur un échantillon aussi bruité ; mesurer l'erreur réellement commise par le prédicteur sur les épisodes passés est plus honnête qu'un statut dérivé d'un simple indice de dispersion |

### Niveau 2 — modèle probabiliste / survie
Intéressant conceptuellement, mais **sur-sophistiqué pour un seul bébé** sous sa forme «
modèle de survie/hazard ». La mise à jour du §3 récupère déjà l'essentiel de ce qui rendait
ce niveau intéressant — un intervalle basé sur des **quantiles empiriques (médiane/P25/P75)**
— directement dans le Niveau 1 redéfini, dès qu'il y a assez de points (~20, pas 50-100
comme envisagé dans la première version de ce document). Pas de fonction de risque lissée
ni de modèle de survie à construire : la mesure de qualité par backtesting (§3.5) remplace
ce que le Niveau 2 visait à apporter, sans le formalisme probabiliste.

### Niveau 3+ — gradient boosting, modèle bayésien hiérarchique, population, LSTM
**Écarté définitivement, pas « pour plus tard »**. Ces niveaux supposent une
infrastructure serveur d'entraînement et surtout un **dataset multi-bébés** qui n'existera
jamais dans ce cadre (app mono-bébé, stockage `localStorage`, sync Supabase entre 2
téléphones uniquement, pas d'autres utilisateurs). Sans population d'autres bébés, un
« prior population » n'a rien à mélanger avec le modèle individuel — le concept même est
vide de sens ici. C'est exactement le point que vous aviez déjà identifié en disant qu'il
n'y a pas de dimension business : ça se traduit techniquement par « ces niveaux n'ont pas
de chemin possible dans ce projet », pas juste « pas prioritaire ».

### Le conseil « concevoir l'API comme probabiliste dès la V1 » (p20/p50/p80/confidence)
Ce conseil a du sens pour une équipe produit qui doit protéger un contrat d'API contre des
clients externes quand le moteur de prédiction change sous le capot. Ici, la même personne
modifie `stats.js` et `app.js` dans le même commit — il n'y a **aucun client externe à
protéger**. Ajouter des champs `p20/p50/p80/confidence` non alimentés par un vrai calcul
introduirait une dette de complexité spéculative dans un fichier (`stats.js`) dont la
force actuelle est justement sa simplicité (« une seule source de vérité, recalcul à la
volée »). Un format simple aujourd'hui, changé en quelques lignes le jour où ça devient
utile, coûte moins cher qu'un format riche mais vide pendant des mois.

---

## 3. Recommandation concrète pour le Niveau 1 (redéfini, v2)

### 3.1 Quatre indicateurs de contexte — informatifs, jamais des portes

**Historique de cette section (important pour ne pas régresser par erreur) :** une version
antérieure de ce document gatait tout affichage — y compris l'onglet labo — tant que quatre
conditions n'étaient pas *simultanément* vraies (âge ≥ 56 jours, volume, performance
mesurée). Cette logique a été **retirée** (§0, mise à jour n°3) : l'app est strictement
personnelle, et vous préférez voir un chiffre approximatif tôt plutôt qu'un mur d'attente.
Les quatre axes ci-dessous existent toujours — ils restent des signaux réels de maturité du
prédicteur — mais ils ne **bloquent plus rien** : ce sont maintenant de simples compteurs
affichés à côté de l'estimation (carte « contexte », §3.8), et la base du badge de confiance
continu décrit en §3.6.

| Axe | Nature | Rôle maintenant |
|---|---|---|
| Âge depuis la naissance (6 août 2026, 5h25) | Contexte informatif, pas une frontière physiologique (§1) | Affiché tel quel (« bébé a X jours ») ; n'influence plus l'affichage |
| Volume — jours fiables depuis `DATA_START.sommeil` | Contexte informatif | Affiché tel quel (« X jours de sommeil suivis ») ; n'influence plus l'affichage |
| Volume — échantillons dans la fenêtre récente | Détermine si un chiffre central et/ou une plage sont *calculables* (§0) | Sous 1 : rien. Sous 3 : chiffre central seul. Au-delà : chiffre + plage, badge de confiance basé sur ce *n* (§3.6) |
| Performance — backtests dans la fenêtre récente | Détermine le badge de confiance de la mesure d'erreur affichée (§3.5-§3.6) | Toujours affiché dès le 1er backtest ; le badge (🌱/🧪/✅) reflète *n*, jamais un mur |

Les deux premiers axes (âge, jours fiables) ne conditionnent plus rien de calculable — ce
sont des faits qu'on choisit d'afficher parce qu'ils aident à interpréter le reste (un
parent qui voit « bébé a 7 jours » sait spontanément relativiser un chiffre à côté). Les
deux derniers (échantillons, backtests) sont les seuls qui ont un effet réel, et cet effet
est désormais **continu** (un badge qui s'affine avec *n*) plutôt que binaire (affiché /
caché) — détail complet en §3.6.

**Ce tableau concerne deux prédicteurs, pas un seul.** Il y a deux estimations distinctes,
chacune affichée indépendamment de l'autre : l'heure d'endormissement (prédicteur 1, §3.2)
et l'heure de réveil (prédicteur 2, §3.3). Les axes « âge » et « jours fiables » sont
partagés (même bébé, même domaine `sommeil`) ; les axes « échantillons récents » et
« backtests récents » sont comptés **indépendamment pour chaque prédicteur**, même si en
pratique les deux compteurs avancent presque en parallèle (un dodo clos fournit à la fois un
écart d'éveil et une durée de sommeil). L'indépendance du comptage n'est pas de la
paranoïa : elle permet à chaque estimation d'afficher *son* propre niveau de maturité sans
être tirée vers le bas par l'autre (§3.6).

### 3.2 Prédicteur 1 — écart d'éveil → heure d'endormissement (fenêtre glissante + médiane/IQR)

Deux changements par rapport à la v1, les deux confirmés justifiés après contre-analyse :

**1. Fenêtre glissante plutôt que pool cumulatif.** Le sommeil néonatal change de régime
chaque semaine (c'est la prémisse même du gating par âge) : pooler tout l'historique depuis
le premier jour mélange mécaniquement des régimes différents et biaise l'estimateur vers
des données obsolètes.
```
W = écarts d'éveil valides parmi les
    min(WW_WINDOW_DAYS = 14 jours civils, WW_WINDOW_MAX_SAMPLES = 40 derniers échantillons)
```
Nuance à ne pas escamoter : dans les 3-4 premières semaines, cette fenêtre ne change rien
par rapport à l'ancien pool cumulatif — il n'y a pas encore 14 jours ni 40 échantillons à
tronquer. C'est un investissement pour la suite (à partir de ~semaine 3-4), pas un bénéfice
immédiat. Et avec la fréquence de sommeil d'un nouveau-né, c'est en pratique la borne des 40
échantillons qui limite la fenêtre (≈ 5-7 jours calendaires), pas les 14 jours — la fenêtre
s'élargira naturellement en durée calendaire quand le rythme se sera espacé (vers 3 mois,
40 échantillons ≈ 14-20 jours).

**2. Médiane + P25/P75, jamais moyenne + min/max.** Le min et le max ne sont pas des bornes
du phénomène : ce sont, par construction, les deux valeurs les plus extrêmes jamais
observées, et elles s'écartent mécaniquement l'une de l'autre à mesure que *n* augmente. Un
texte du type « l'éveil a duré entre 38 et 96 min » laisse croire à des bornes réelles alors
que ce sont deux accidents rares — c'est trompeur, pas juste imprécis. La médiane est en
outre plus robuste que la moyenne face aux oublis de saisie qui passent le filtre
`WAKE_GAP_MAX_MS` (un réveil de 3h reste plausible mais tire fortement une moyenne à si
faible *n*).
```
durée_éveil_prédite  = médiane(W)
endormissement_prévu = dernier_réveil + durée_éveil_prédite
intervalle_affiché    = [P25(W), P75(W)]
```
Ce prédicteur s'arrête à l'endormissement — il ne dit rien sur l'heure de réveil qui suit.
C'est volontaire : l'heure de réveil dépend d'une deuxième quantité, la durée du sommeil qui
commence à `endormissement_prévu`, qui a sa propre dynamique et son propre risque
statistique (bimodal sieste/nuit) — voir §3.3. Mélanger les deux dans un seul prédicteur
reviendrait à réintroduire par un autre chemin la segmentation sieste/nuit déjà écartée en
§1-§2 pour la fenêtre d'éveil.

Important pour le registre du texte (§3.9) : à *n*=15-25, le P25/P75 empirique reste
sensible à 1-2 points — ce n'est pas un intervalle « garanti », c'est un ordre de grandeur
« le plus souvent entre X et Y ». Ce que la médiane/IQR apporte à ce stade, ce n'est pas la
précision, c'est l'absence du mensonge structurel du min/max. Cette imprécision ne justifie
pas de cacher le chiffre (§0) : elle justifie de l'accompagner d'un badge de confiance
honnête (🌱/🧪/✅, §3.6) plutôt que de le remplacer par un silence. Concrètement :
`endormissement_prévu` s'affiche dès *n*=1 (la médiane d'un seul point est ce point-là —
trivial mais réel), `intervalle_affiché` s'y ajoute dès *n* ≥ `WW_MIN_SAMPLES_FOR_RANGE`
(3).

```js
// Constantes nommées à ajouter dans stats.js — « dur » = plancher mathématique réel (pas
// un choix de prudence), « produit » = choix de prudence explicitement arbitraire (indiqué
// en commentaire). Aucune de ces constantes ne cache l'estimation (§0) — voir §3.6 pour le
// rôle exact de chacune dans le badge de confiance continu.
WAKE_GAP_MAX_MS:            12 * 60 * 60 * 1000, // dur — filtre de saisie, inchangé
WW_WINDOW_DAYS:             14,                   // produit — fenêtre glissante
WW_WINDOW_MAX_SAMPLES:      40,                    // produit — plafond de la fenêtre
WW_MIN_SAMPLES_FOR_RANGE:   3,                     // dur — sous ce seuil, P25/P75 ne seraient que les points bruts eux-mêmes : on affiche alors le chiffre central (médiane) SEUL, jamais rien
```

Résolution des épisodes toujours via `_resolveSleep()` ([stats.js:62](stats.js#L62)), écarts
calculés comme en v1 (fin(épisode_i) → début(épisode_i+1)), dodos en cours et écarts
négatifs exclus. Aucun changement du schéma d'événement `{ ts, data:{end} }`, aucun champ
`nap_index` stocké — inchangé par rapport à la v1.

> **Source d'entrée obligatoire : `Stats.sleepEpisodes(events, { nowMs })`** (déjà livré,
> testé), qui rend les épisodes **triés par début croissant** — les écarts d'éveil n'ont
> de sens que sur une liste triée — et marqués `{ ongoing, aberrant, overlapsPrev }`.
> **Les deux prédicteurs écartent les épisodes `aberrant` (durée ≥ 16 h : oubli d'arrêt)
> et `overlapsPrev` (même sieste saisie depuis les 2 téléphones), ainsi que les écarts
> qui les encadrent.** Les stats descriptives, elles, les comptent volontairement
> (§0.3 de `SPECS-stats.md`) : une médiane est en revanche très sensible à un « dodo » de
> 30 h ou à une sieste comptée deux fois. Ces épisodes restent visibles dans l'encart
> « Qualité des données », donc corrigeables par un parent.

### 3.3 Prédicteur 2 (nouveau) — durée de sommeil → heure de réveil

Structurellement identique au prédicteur 1, appliqué à une autre quantité : au lieu de
l'écart entre un réveil et l'endormissement suivant, on pool la **durée de l'épisode de
sommeil** (début → fin, déjà calculée par `_resolveSleep()`), sur la même mécanique fenêtre
glissante + médiane/P25-P75.

```
D = durées de sommeil valides parmi les
    min(SD_WINDOW_DAYS = 14 jours civils, SD_WINDOW_MAX_SAMPLES = 40 derniers épisodes)
durée_sommeil_prédite = médiane(D)
intervalle_durée      = [P25(D), P75(D)]
```

**Pourquoi ce n'est pas un simple copier-coller du prédicteur 1, malgré la formule
identique** : la durée de sommeil est *structurellement* bimodale à cet âge, pas juste plus
dispersée. L'écart d'éveil d'un nouveau-né reste dans une plage multiplicative resserrée
(environ 30 min à 3h, rythme ultradien lié à la faim). La durée de sommeil, elle, mélange
des micro-siestes de 20 min et des blocs de nuit de 6h+ — un rapport potentiel de 15 à 20
fois entre les deux régimes, et ce sont deux régimes réels (pas juste du bruit) tant que la
segmentation jour/nuit écartée en §1 n'existe pas. C'est exactement le type de risque que ce
document refuse de résoudre par une segmentation prématurée (WW1/WW2/WW3, §2) — la
différence, c'est qu'ici on **peut mesurer l'erreur réellement commise** (§3.5) au lieu de
deviner si le pool tient la route. Le backtest est le juge, pas une hypothèse a priori sur
la bimodalité.

Ceci dit, un backtest qui franchit son seuil de volume (§3.5) ne garantit pas que l'erreur
soit *petite* — il garantit seulement que la mesure d'erreur est fiable. Un prédicteur de
durée peut très bien atteindre 40 backtests avec une erreur médiane de 90 minutes et un IQR
de 5 heures : ce n'est pas un mensonge de l'afficher tel quel, mais un chiffre aussi large
mérite d'être expliqué plutôt que présenté à plat. D'où un indicateur produit
supplémentaire, spécifique à ce prédicteur : quand la dispersion est disproportionnée par
rapport à la médiane, on **n'efface plus rien** (§0) — on ajoute une mention explicite à
côté de la plage affichée, dans l'onglet comme dans le Stats tab s'il y en a un :
```
si (P75(D) - P25(D)) / médiane(D) > SD_MAX_IQR_MEDIAN_RATIO :
    -> afficher intervalle_durée ET la plage de réveil qui en découle (§3.4) normalement,
       avec la mention accolée « ⚠️ plage large : à cet âge, la durée de sommeil mélange
       siestes courtes et nuits longues — prends ça comme un ordre de grandeur, pas une
       promesse »
```

```js
// Constantes nommées à ajouter dans stats.js, même convention « dur »/« produit » qu'en §3.2 :
SD_WINDOW_DAYS:              14,   // produit — même point de départ que WW_WINDOW_DAYS, ajustable indépendamment
SD_WINDOW_MAX_SAMPLES:       40,   // produit — idem
SD_MIN_SAMPLES_FOR_RANGE:    3,    // dur — même logique que WW_MIN_SAMPLES_FOR_RANGE (§3.2) : sous ce seuil, chiffre central seul, jamais rien
SD_MAX_IQR_MEDIAN_RATIO:     2.5,  // produit — déclenche une mention « ⚠️ plage large » accolée à la plage ; ne masque plus rien (§0)
```
Fenêtres indépendantes plutôt que réutilisation littérale de `WW_*` : la structure
sieste/nuit se consolide vite (rythme circadien émergent, §1), potentiellement plus vite que
l'écart d'éveil ne dérive lui-même — la durée de sommeil a donc plus de raisons de devenir
obsolète rapidement. Démarrer avec les mêmes valeurs (14j/40) est un point de départ
raisonnable ; laisser chaque backtest (pas un raisonnement a priori) dire, plus tard, si la
fenêtre de la durée doit être resserrée indépendamment de celle de l'écart d'éveil.

### 3.4 Assembler la plage complète : chaîner les points, jamais additionner les intervalles

C'est le point le plus facile à rater techniquement en ajoutant un deuxième prédicteur : la
tentation est d'additionner les deux intervalles (`P25_éveil + P25_durée`, `P75_éveil +
P75_durée`) pour obtenir une plage de réveil. **Ne pas faire ça**, pour deux raisons
empilées, pas juste une :

1. Même sous indépendance parfaite, la somme de deux quantiles marginaux n'est pas le
   quantile de la somme (effets de concentration qui la déforment, sens de la déformation
   dépendant des formes des deux distributions) — l'arithmétique ne veut rien dire de précis
   ici.
2. Plus important dans ce cas précis : l'heure d'endormissement et la durée du sommeil qui
   suit **ne sont pas indépendantes** avant que la segmentation jour/nuit (écartée jusqu'à
   10-12 semaines, §1) n'existe. Un endormissement en soirée présage un long bloc de nuit ;
   un endormissement en milieu de journée présage une courte sieste. C'est exactement le
   confondant que le pooling non segmenté reporte à plus tard — aucune formule, naïve ou
   « correcte », ne le corrige tant que cette segmentation n'existe pas.

**Ce qu'on fait à la place :**
```
réveil_prévu (point central) = endormissement_prévu + durée_sommeil_prédite   (médiane + médiane)
plage_réveil_affichée         = [réveil_prévu - RT_P25_err, réveil_prévu + RT_P75_err]
                                 -- ces deux bornes viennent du backtest « round-trip »
                                    du §3.5, PAS d'une opération sur les intervalles
                                    ci-dessus
```
Le point central est un chaînage standard et défendable (médiane + médiane). La plage, elle,
n'est pas calculée — elle est **mesurée directement** : c'est l'erreur réelle (P25/P75) du
backtest chaîné (§3.5, 3e métrique), qui capture automatiquement la dépendance entre les deux
étapes sans qu'aucune hypothèse de forme ou d'indépendance soit nécessaire. C'est plus
honnête qu'une formule qui aurait l'air rigoureuse sans l'être.

**Cas particulier — zéro round-trip mesuré encore (`n(E_RT) = 0`) :** ça peut arriver
brièvement au tout début, si les deux prédicteurs n'ont pas encore chacun au moins
`BACKTEST_MIN_TRAIN_SAMPLES` (§3.5) au même moment. Comme rien ne doit rester invisible
(§0), la plage affichée retombe alors, **temporairement et explicitement étiquetée comme
telle**, sur la seule option restante — l'addition naïve des deux intervalles
(`P25_éveil + P25_durée`, `P75_éveil + P75_durée`) — avec la mention accolée
« approximation grossière, pas encore mesurée : sera remplacée dès le premier round-trip
observé ». C'est la même addition rejetée plus haut, réutilisée ici uniquement comme
solution de repli honnêtement nommée, pas comme méthode définitive — dès qu'il existe au
moins 1 round-trip mesuré, cette solution de repli disparaît et la vraie plage mesurée prend
sa place.

### 3.5 Le backtesting silencieux — deux prédicteurs indépendants, plus une mesure diagnostique chaînée

C'est la correction la plus significative apportée par la contre-analyse de ChatGPT — et le
point sur lequel la v1 de ce document se contentait d'un critère plus faible que
nécessaire (le CV). La question qui compte n'est pas *« est-ce que les durées d'éveil sont
dispersées ? »* mais *« est-ce que le prédicteur réussit à prédire les épisodes suivants,
pour CE bébé ? »* — et cette question, contrairement à une segmentation par sieste ou un
modèle bayésien, **l'application peut la mesurer elle-même, sans aucune donnée externe.**
Avec deux prédicteurs (§3.2, §3.3), il faut **deux logs de backtest indépendants** — pas un
seul combiné. Un troisième calcul, purement diagnostique, mesure le chaînage des deux (§3.4).

**Pourquoi deux backtests séparés, pas un seul combiné bout-en-bout** : deux prédicteurs
biaisés peuvent produire une erreur combinée trompeusement bonne par annulation (l'un
prédit trop tôt, l'autre trop tard, ça se compense sur le round-trip sans que ni l'un ni
l'autre ne soit réellement fiable) — un cas classique de fausse réassurance. Garder deux
logs et deux seuils indépendants permet de détecter qu'*un seul* étage dérape, ce qu'une
métrique unique masquerait.

**Mécanique — validation glissante dans le temps (walk-forward), sans fuite du futur,
répétée à l'identique pour chaque prédicteur :**
```
Pour chaque nouvel épisode d'éveil g_n (prédicteur 1, endormissement) :
  W_(n) = fenêtre récente calculée UNIQUEMENT sur g_1..g_(n-1)
  si n(W_(n)) >= BACKTEST_MIN_TRAIN_SAMPLES (3) :
      pred_n = médiane(W_(n)) ; erreur_n = g_n - pred_n -> logger (erreur_n, date, âge)

Pour chaque nouvel épisode de sommeil d_n (prédicteur 2, réveil) :
  D_(n) = fenêtre récente calculée UNIQUEMENT sur d_1..d_(n-1)
  si n(D_(n)) >= SD_BACKTEST_MIN_TRAIN_SAMPLES (3) :
      pred_n = médiane(D_(n)) ; erreur_n = d_n - pred_n -> logger (erreur_n, date, âge)

Round-trip (diagnostique uniquement, jamais un gate — voir §3.4) :
  pour chaque épisode où les DEUX prédictions ci-dessus étaient dispo au moment g_n/d_n :
      réveil_prévu_n = (dernier_réveil + médiane(W_(n))) + médiane(D_(n))
      erreur_RT_n    = réveil_réel_n - réveil_prévu_n -> logger

E_onset  = { |erreur_n| des BACKTEST_TIER_SOLID_N backtests prédicteur-1 les plus récents (ou tous s'il y en a moins) }
E_wake   = { |erreur_n| des SD_BACKTEST_TIER_SOLID_N backtests prédicteur-2 les plus récents (ou tous s'il y en a moins) }
E_RT     = { |erreur_RT_n| des RT_TIER_SOLID_N round-trips les plus récents (ou tous s'il y en a moins) }
```

**Planchers et paliers, distincts par prédicteur + un troisième pour le diagnostic chaîné.**
Nommage volontairement différent de la version précédente de ce document : aucune de ces
constantes n'est un plancher d'affichage (§0) — `BACKTEST_TIER_EMERGING_N` et
`BACKTEST_TIER_SOLID_N` sont les deux bornes du badge de confiance continu (🌱/🧪/✅, §3.6),
pas des conditions qui décident si quelque chose s'affiche :
```js
BACKTEST_MIN_TRAIN_SAMPLES:    3,   // dur — prédicteur 1, même plancher que WW_MIN_SAMPLES_FOR_RANGE, appliqué à la fenêtre d'entraînement du backtest
BACKTEST_TIER_EMERGING_N:      20,  // dur (ordre de grandeur) — prédicteur 1, sous ce nombre de backtests : badge 🌱
BACKTEST_TIER_SOLID_N:         40,  // dur (ordre de grandeur) — prédicteur 1, à partir de ce nombre : badge ✅ (entre les deux : 🧪) ; double aussi comme taille de fenêtre glissante pour E_onset
SD_BACKTEST_MIN_TRAIN_SAMPLES: 3,   // dur — prédicteur 2, même logique
SD_BACKTEST_TIER_EMERGING_N:   20,  // dur — prédicteur 2, idem
SD_BACKTEST_TIER_SOLID_N:      40,  // dur (ordre de grandeur) — prédicteur 2, idem
RT_TIER_EMERGING_N:            20,  // dur — round-trip, idem, pour le badge accolé à la plage de réveil (§3.4)
RT_TIER_SOLID_N:               40,  // dur (ordre de grandeur) — round-trip, idem ; source de la plage de réveil (§3.4), ne bloque jamais l'affichage des deux estimations elles-mêmes
```

**Démarrage : dès maintenant, silencieusement, pour les deux prédicteurs.** C'est le point
le plus tranché de la contre-analyse originale, encore renforcé par la décision du §0 de ne
plus rien cacher : le coût est nul, et c'est le **seul moyen de savoir empiriquement, pour
ce bébé précis**, quand chaque prédicteur devient bon — plutôt que de deviner un âge
générique tiré de la littérature ou d'un concurrent. Concrètement : les deux backtests
tournent dès que le domaine `sommeil` est fiable, soit **depuis le 11 août 2026**, et leurs
résultats s'affichent au fur et à mesure (§3.6) — aucun seuil d'âge, de volume ou de nombre
de backtests ne bloque plus rien, ni le calcul ni l'affichage.

**Persistance : aucune, et c'est voulu.** Le pseudocode ci-dessus (« logger (erreur_n, date,
âge) ») décrit une opération logique, pas un log stocké séparément dans `localStorage`. Le
principe déjà central au projet (« source de vérité unique, recalcul à la volée, pas de
cache », §3.7/§3.11) s'applique aussi au backtest : à chaque ouverture de l'onglet
Prédiction, la boucle walk-forward ci-dessus **rejoue tout l'historique** `sommeil` depuis
`DATA_START.sommeil` pour reconstruire `E_onset`/`E_wake`/`E_RT` de zéro, exactement comme
`Stats.compute()` reconstruit déjà toutes ses stats de zéro à chaque ouverture de l'onglet
Stats. Ce n'est pas O(fenêtre glissante) — ça grandit avec l'historique total, sans borne —
mais reste négligeable en pratique pour un seul bébé (des centaines d'épisodes par an, pas
des dizaines de milliers) ; voir §3.7 pour la distinction entre ce coût-là et celui,
réellement borné, du calcul de la prédiction elle-même.

### 3.6 Affichage continu — un badge de confiance, jamais un mur

Remplace intégralement le critère `CV ≤ 0.45` de la toute première version de ce document —
un ratio de deux estimateurs eux-mêmes instables à faible *n* (l'écart-type est *plus*
volatil que la moyenne), qui pouvait passer à « régulière » par simple chance sur une semaine
calme — **et** remplace le système de portes à quatre axes d'une version intermédiaire de ce
document (§3.1), retiré par la décision du §0.

**Règle unique, valable pour les deux prédicteurs et pour le diagnostic round-trip :**
```
dès qu'il y a n ≥ 1 point (échantillon ou backtest, selon le chiffre concerné) :
  → afficher le chiffre — jamais de silence, jamais de « pas encore assez de recul »

le badge de confiance qui l'accompagne est dérivé du même n, en trois paliers :
  n < TIER_EMERGING_N        → 🌱 « très approximatif (n=X) »
  TIER_EMERGING_N ≤ n < TIER_SOLID_N → 🧪 « encore incertain (n=X) »
  n ≥ TIER_SOLID_N           → ✅ « plus robuste (n=X) »
```
La fonction de badge est **unique et générique** — elle prend n'importe quel compteur en
entrée (échantillon brut ou backtest) et les deux bornes 20/40, et retourne 🌱/🧪/✅. Elle ne
distingue pas la *nature* du compteur, seulement sa valeur. Référence d'implémentation :
`tierBadge(n, emerging = 20, solid = 40)` dans `mockup-prediction.html` — c'est la même
fonction, appelée avec des arguments différents, qui produit le badge de chaque carte.

Appliqué concrètement (constantes définies en §3.2-§3.5) :
- Estimation d'endormissement (§3.2) : badge basé sur *n* échantillons dans la fenêtre
  récente, en réutilisant directement les bornes génériques 20/40 (mêmes valeurs que
  `BACKTEST_TIER_EMERGING_N`/`BACKTEST_TIER_SOLID_N`, §3.5) — **sans constante dédiée
  séparée pour l'échantillon brut** : une seule paire de seuils suffit, elle est juste
  appliquée une deuxième fois à un compteur différent de celui du backtest. Affiche déjà un
  point à *n*=1, une plage à *n* ≥ `WW_MIN_SAMPLES_FOR_RANGE` (3).
- Qualité mesurée de ce même prédicteur (le backtest, §3.5) : même fonction de badge,
  appliquée à *n* backtests, avec cette fois des constantes nommées dédiées
  (`BACKTEST_TIER_EMERGING_N` (20) / `BACKTEST_TIER_SOLID_N` (40)) — parce que le backtest a
  son propre cycle de vie, indépendant de l'échantillon brut (les deux *n* divergent dès que
  `BACKTEST_MIN_TRAIN_SAMPLES` retarde le démarrage du backtest par rapport au premier
  échantillon, §3.5).
- Estimation de réveil (§3.3) et sa qualité mesurée (§3.5) : même logique — l'échantillon
  brut réutilise les bornes génériques 20/40, le backtest a ses constantes dédiées `SD_*`.
- Plage de réveil round-trip (§3.4) : badge basé sur *n* round-trips, paliers
  `RT_TIER_EMERGING_N` (20) / `RT_TIER_SOLID_N` (40) ; en dessous de *n*=1, solution de
  repli explicitement étiquetée décrite en §3.4.

**Les deux estimations (endormissement, réveil) s'affichent indépendamment, avec leur propre
badge.** Rien n'oblige à attendre que les deux atteignent le même palier : si l'endormissement
est déjà ✅ et le réveil encore 🌱, on affiche les deux tels quels — chacun avec son badge
honnête. C'est déjà actionnable pour un parent (ou, ici, pour vous), et artificiellement tirer
l'un vers le bas parce que l'autre est moins mûr serait perdre de l'information pour rien. Le
diagnostic chaîné (`E_RT`) n'a pas de « fiabilité » affichée séparément de son propre badge —
il sert uniquement à dimensionner la plage de réveil (§3.4), avec son badge accolé.

Pas d'état intermédiaire narratif du type « tendance émergente » : à tout moment, ce qui
s'affiche est soit un chiffre mesuré directement (issu du backtest ou de la fenêtre récente),
soit — au tout début, avant *n*=1 — rien, parce qu'il n'y a littéralement rien à mesurer.
Aucun demi-signal dérivé indirectement de la dispersion des données brutes.

### 3.7 Cadence de recalcul (nouveau — réponse à votre question)

**Recommandation : recalcul à la demande pour tout ce qui touche au prédicteur, plus un
rafraîchissement léger toutes les 60s réservé à l'affichage relatif au temps qui passe — en
réutilisant un pattern qui existe déjà dans le code, pas une nouvelle architecture.**

Fait vérifié dans le code actuel (pas supposé) : `renderStats()` et `Stats.compute()`
([app.js:1158](app.js#L1158)) ne tournent **que** sur ouverture/bascule d'onglet
(`renderCurrent()`, [app.js:470](app.js#L470)) ou clic sur un bouton de période
([app.js:1310](app.js#L1310)) — zéro timer, zéro recalcul après un `Store.add`/`update`. Le
seul timer récurrent de toute l'app est [app.js:1836](app.js#L1836) :
```js
setInterval(() => { if (currentView === 'suivi') { renderStatusStrip(); renderGrid(); } }, 60000);
```
Toutes les 60s, uniquement si l'onglet Suivi est affiché, et **uniquement** pour rafraîchir
des libellés relatifs au temps (« il y a 1h20 », le compteur ⏱ d'un dodo en cours) — jamais
pour recalculer une statistique.

**Ce qui en découle pour l'onglet Prédiction :**
1. **Recalcul lourd** (fenêtre glissante + rejeu des deux backtests, §3.2-3.6) : uniquement
   à l'ouverture/bascule vers l'onglet Prédiction, exactement comme `renderStats()`
   aujourd'hui — pas de timer dédié. Deux coûts de nature différente, à ne pas confondre :
   la *prédiction* elle-même est bornée (≤ 40 échantillons / 14 jours, §3.2-3.3), donc
   trivialement négligeable ; le *rejeu du backtest* (§3.5) parcourt tout l'historique
   `sommeil` depuis `DATA_START.sommeil` et n'est donc pas borné par construction — mais
   reste négligeable en pratique pour un seul bébé (des centaines d'épisodes, pas des
   dizaines de milliers), exactement comme `Stats.compute()` recalcule déjà tout l'historique
   à chaque ouverture de l'onglet Stats sans que ça pose de problème mesurable. Un timer
   dédié gaspillerait du CPU sans gagner en fraîcheur : rien ne change dans les données entre
   deux ouvertures sans nouvel événement `sommeil`.
2. **Rafraîchissement léger** (comparaison « il est actuellement HH:MM, réveil estimé à
   HH:MM, donc dans X min / en retard de X min », et le compteur ⏱ depuis le dernier réveil) :
   étendre la garde du timer existant à `currentView === 'prediction'`, même cadence de 60s,
   sans recalculer le prédicteur — juste rafraîchir l'écart entre l'heure actuelle et
   l'estimation déjà calculée. Aucune nouvelle primitive : cadence déjà validée dans ce
   projet pour un besoin analogue.

Ne pas ajouter de recalcul déclenché par mutation (`Store.add`/`update` → recalcul
immédiat) : ça compliquerait le flux d'écriture pour un gain invisible tant que l'onglet
n'est pas affiché, et le recalcul à l'ouverture couvre déjà le cas qui compte (le parent
ouvre l'onglet, voit des chiffres à jour).

### 3.8 Nouveau : un 4e onglet « Prédiction », en mode laboratoire (votre demande)

Vous avez demandé un onglet dédié pour suivre le backtesting « pour s'amuser et comprendre,
même si c'est faux parce que trop prématuré ». Une version antérieure de ce document
résolvait la tension apparente entre « c'est prématuré » et « je veux le voir maintenant »
en gatant la *revendication* plutôt que la *visibilité* : l'onglet était visible dès le
premier backtest, mais chaque estimation à l'intérieur restait cachée derrière le seuil du
§3.1 tant qu'elle n'était pas jugée assez mûre. **Cette dernière limite est retirée elle
aussi** (§0) : dans cet onglet, tout ce qui est calculable s'affiche, point.

Ce qui reste, et qui n'a jamais été une question de fiabilité mais de canal d'affichage :
les estimations restent confinées à cet onglet, jamais poussées passivement dans l'onglet
Suivi (pas de bandeau « prochaine sieste 14:32 » sur l'écran d'accueil) et jamais via
notification. Ouvrir volontairement un onglet clairement intitulé « laboratoire /
expérimental » pour aller y lire des chiffres qu'on sait provisoires n'est pas la même chose
qu'un message non sollicité sur l'écran qu'on regarde 30 fois par jour — cette distinction-là
reste valable indépendamment de la question du gating, et n'a pas besoin des quatre axes du
§3.1 pour se justifier.

**Contenu proposé, mis à jour pour les deux prédicteurs, toujours visible dès qu'il y a une
donnée à montrer** (mockup HTML séparé fourni — [mockup-prediction.html](mockup-prediction.html)) :
1. **Carte « contexte »** : les quatre indicateurs du §3.1 sous forme de compteurs
   informatifs — âge et jours fiables partagés, puis échantillons/backtests **dédoublés**
   (un compteur pour l'endormissement, un pour le réveil). Purement informatif : aucun état
   global du type « collecte / en calcul / signal exploitable » — ces comptages n'ouvrent ni
   ne ferment plus rien, ils aident juste à interpréter les cartes suivantes.
2. **Carte « estimation actuelle »**, toujours étiquetée *expérimental*, en **deux blocs**
   plutôt qu'un : « 🌙 Endormissement estimé » (heure d'horloge + plage, converti depuis la
   médiane/P25-P75 du §3.2 — plus une durée seule, badge 🌱/🧪/✅ accolé) et « 🌅 Réveil
   estimé » (heure d'horloge, point central chaîné du §3.4, plage issue du round-trip avec
   son propre badge — ou de la solution de repli explicitement étiquetée si aucun round-trip
   n'est encore mesuré, §3.4 ; mention « ⚠️ plage large » accolée si `SD_MAX_IQR_MEDIAN_RATIO`
   déclenche, §3.3, sans jamais masquer la plage). Chaque bloc affiche un chiffre dès
   *n*=1 pour son prédicteur, une plage dès *n*=3 (`WW_MIN_SAMPLES_FOR_RANGE` /
   `SD_MIN_SAMPLES_FOR_RANGE`) — l'un peut être plus mûr que l'autre, jamais vide si une
   seule donnée existe.
3. **Deux cartes « qualité du backtest »** (une par prédicteur, même structure que
   l'existante) : graphique d'erreur absolue par backtest dans le temps (réutilise le style
   `statChartBars`/palette `CHART`), chiffres bruts (erreur médiane, P80, *n*, badge 🌱/🧪/✅)
   — affichés dès le premier backtest, aussi bruyants soient-ils à *n*=1. Une note discrète,
   sur la carte réveil uniquement (jamais sur la carte endormissement — c'est la durée de
   sommeil, pas l'écart d'éveil, qui est structurellement bimodale à cet âge, §3.3), rappelle
   que la durée de sommeil est plus dispersée que l'écart d'éveil, pour qu'une erreur de
   backtest plus grande sur cette carte ne soit pas lue comme un bug. Texte exact en §3.9
   (`#q2Note` dans le mockup).
4. **Tableau « prédiction vs réalité »**, en deux sous-tableaux (endormissement, réveil) —
   chacun affiche ses propres lignes dès qu'il en existe, indépendamment de l'autre.
5. Bandeau d'avertissement permanent en haut de l'onglet, sur le thème visuel déjà existant
   pour les avertissements (`.quality-box`, orange) : *« Onglet expérimental : ces chiffres
   sont recalculés en direct à partir de ce qui est déjà mesuré pour ce bébé. Avec peu de
   données, ils sont volontairement affichés quand même — regarde le badge et le *n* de
   chaque carte pour juger toi-même à quel point t'y fier. »*

**Intégration technique** (repérée précisément dans le code existant) :
- `index.html` — ajouter `<div class="view" id="view-prediction" hidden></div>` à côté de
  `view-stats` (juste avant la fermeture de `#app`, autour de la ligne 82-84).
- `app.js:316-320` (tableau `VIEWS`) — ajouter `{ id: 'prediction', label: 'Prédiction',
  emoji: '🔮' }` (4e entrée ; le commentaire au-dessus de `VIEWS`, *« extensible : ajouter
  'calendrier' plus tard »*, anticipait déjà cette extensibilité).
- `app.js:470-475` (`renderCurrent`) — ajouter la branche
  `else if (currentView === 'prediction') renderPrediction();`.
- Réutiliser tel quel : `.view-header h1`, `.stat-grid`/`.stat-card`/`.sc-head`/`.sc-title`/
  `.sc-hero`/`.sc-sub`/`.sc-chart` (cartes), `statChartBars` + palette `CHART` (graphique
  d'erreur), `<details class="stat-details">` (sections repliables, ex. le tableau
  prédiction/réalité), `.quality-box` (bandeau d'avertissement — même famille visuelle que
  « Qualité des données » déjà dans Stats, sémantiquement juste : même registre « à prendre
  avec précaution »). Aucune adaptation dark mode nécessaire (absent du projet).
- Détail d'implémentation vérifié : le générateur `card()` utilisé dans `renderStats()`
  ([app.js:1206](app.js#L1206)) est une **const locale**, pas une fonction exportée
  réutilisable — `renderPrediction()` aura besoin de son propre petit générateur de carte
  (même gabarit HTML, dupliqué à l'identique, pas partagé) plutôt que d'appeler celui de
  Stats depuis l'extérieur.

**Ce que cet onglet n'est pas** : un canal qui pousse quoi que ce soit vers l'onglet Suivi
ou vers une notification. Ce n'est plus une question de gating (§0, §3.1) mais de canal —
l'estimation reste disponible uniquement pour qui ouvre volontairement cet onglet, jamais
affichée passivement sur l'écran qu'on regarde par défaut.

### 3.9 Textes UI (français)

**Changement clé par rapport à la première mouture** : l'estimation ne s'exprime plus
seulement en durée d'éveil — elle se **convertit en heure d'horloge**
(`endormissement_prévu` = dernier réveil + médiane, §3.2), et le réveil se chaîne en heure
d'horloge lui aussi (§3.4). La durée reste mentionnée en accompagnement (« environ 61 min »),
mais l'heure d'horloge est maintenant le chiffre principal — c'est ce qui est directement
actionnable pour qui veut savoir « à quelle heure je le recouche ».

**Simplification apportée par la mise à jour n°3 (§0) : un seul emplacement d'affichage.**
Une version antérieure de ce document proposait aussi un écho factuel dans l'onglet Stats,
gaté séparément par le §3.1/§3.6. Ce deuxième emplacement est retiré : puisque l'onglet
Prédiction (§3.8) affiche déjà tout sans condition, dupliquer le même chiffre dans Stats
n'apporterait rien et ajouterait une deuxième surface à garder synchronisée pour rien.
**Tous les textes ci-dessous vivent uniquement dans l'onglet Prédiction.**

**Dans l'onglet Prédiction** (mode laboratoire, ton explicitement expérimental, un badge
🌱/🧪/✅ toujours visible à côté de chaque chiffre — jamais de silence). Les trois exemples
ci-dessous ne sont pas une reformulation libre : ce sont **les sorties textuelles réelles**
de `renderState()` dans `mockup-prediction.html`, pour `STATES.j7`, `STATES.s3` et
`STATES.s9` respectivement — ouvrez le mockup et sélectionnez l'état correspondant pour
vérifier littéralement, plutôt que de faire confiance à cette prose seule.

- **J7 — un seul réveil mesuré** (`STATES.j7` : *n*=1 pour l'endormissement, pas encore de
  plage possible tant que *n* < `WW_MIN_SAMPLES_FOR_RANGE` = 3 ; *n*=0 partout ailleurs) :
  > *« 08:12 endormissement 🌙 🌱 — ≈ 72 min d'éveil — une seule mesure, pas encore de plage
  > possible (dès n=3). »* puis, en badge accolé : *« 🌱 très approximatif (n=1) · basé sur
  > 1 réveil récent — expérimental, à prendre avec précaution. »*
  > *« Réveil 🌅 : Aucune durée de sommeil mesurée encore pour ce bébé (n=0) — rien à
  > estimer pour l'instant. »*
  > Les deux cartes « Qualité du backtest » affichent *« — »* et *« Aucun backtest encore
  > (n=0). »* ; les deux tableaux affichent *« Aucune prédiction backtestée encore (n=0). »*
- **~3 semaines** (`STATES.s3` : *n*=18 réveils / 14 backtests pour l'endormissement,
  *n*=16 sommeils / 13 round-trips pour le réveil) :
  > *« 15:13 endormissement 🌙 🌱 — Le plus souvent entre 15:00 et 15:29 (≈ 58 min
  > d'éveil). »* badge : *« 🌱 très approximatif (n=18) · basé sur 18 réveils récents —
  > expérimental, à prendre avec précaution. »*
  > *« Qualité du backtest — endormissement : 24 min d'écart médian 🌱 — 80 % des
  > prédictions à ± 38 min · 14 backtests récents · très approximatif (n=14). »*
  > *« 16:33 réveil 🌅 🌱 — Le plus souvent entre 15:59 et 17:25 (≈ 1 h 20 de sommeil). 🌱
  > plage basée sur 13 round-trips mesurés. ⚠️ plage large : à cet âge, la durée de sommeil
  > mélange siestes courtes et nuits longues — prends ça comme un ordre de grandeur, pas une
  > promesse. »* badge : *« 🌱 très approximatif (n=16) · chaîné à partir de l'endormissement
  > estimé — jamais une addition de deux plages pour le point central. »*
  > *« Qualité du backtest — réveil : 48 min d'écart médian 🌱 — 80 % des prédictions à ±
  > 68 min · 13 backtests récents · très approximatif (n=13). »* note accolée (toujours
  > affichée dès qu'il y a une durée à commenter) : *« Rappel : la durée de sommeil est plus
  > dispersée que l'écart d'éveil à cet âge (siestes et nuits mélangées) — un écart plus
  > grand ici est attendu, pas forcément un bug. »*
- **~9 semaines** (`STATES.s9` : *n*=40 réveils / 40 backtests pour l'endormissement,
  *n*=42 sommeils / 45 backtests / 42 round-trips pour le réveil) :
  > *« 08:27 endormissement 🌙 ✅ — Le plus souvent entre 08:15 et 08:39 (≈ 67 min
  > d'éveil). »* badge : *« ✅ plus robuste (n=40) · basé sur 40 réveils récents —
  > expérimental, à prendre avec précaution. »*
  > *« Qualité du backtest — endormissement : 11 min d'écart médian ✅ — 80 % des
  > prédictions à ± 19 min · 40 backtests récents · plus robuste (n=40). »*
  > *« 10:12 réveil 🌅 ✅ — Le plus souvent entre 09:53 et 10:31 (≈ 1 h 45 de sommeil). ✅
  > plage basée sur 42 round-trips mesurés. »* (pas de mention « plage large » : à ce stade
  > l'IQR de la durée de sommeil est redescendu sous `SD_MAX_IQR_MEDIAN_RATIO`) badge :
  > *« ✅ plus robuste (n=42) · chaîné à partir de l'endormissement estimé — jamais une
  > addition de deux plages pour le point central. »*
  > *« Qualité du backtest — réveil : 22 min d'écart médian ✅ — 80 % des prédictions à ±
  > 39 min · 45 backtests récents · plus robuste (n=45). »*

Ce qui n'apparaît **jamais** : un pourcentage de confiance (« confiance : 62 % »), une heure
ponctuelle sans plage une fois que la plage est calculable (*n* ≥ 3) sans mention de
fourchette, une plage de réveil obtenue en additionnant deux intervalles sans le dire (§3.4),
une notification poussée, un état vide alors qu'au moins un point de donnée existe (§0).

### 3.10 Valider une future feature (durée sieste précédente, heure du jour...) : par backtest, plus par Spearman

La v1 proposait un test de corrélation de Spearman significatif sur 30-40 paires avant
d'ajouter une variable. La contre-analyse a raison de rejeter cette approche : un Spearman
teste une association rétrospective, en vrac, sans respecter l'ordre temporel — il ne
répond pas à la seule question qui compte, *« si j'utilise cette variable pour prédire
avant de connaître le résultat, me trompe-je moins ? »* Une corrélation peut être
significative sans apporter de gain prédictif réel une fois l'ordre temporel respecté (fuite
d'information), et l'inverse est vrai aussi (test non significatif à si petit *n*, alors que
la variable aide en pratique).

**Remplacement : comparaison directe de l'erreur de backtest, en paires, avec garde-fous
contre le sur-ajustement prédictif** (le risque principal — cousin du p-hacking classique,
aggravé ici par l'autocorrélation des points d'un même bébé et par la dérive du processus
semaine après semaine) :
```js
FEATURE_MIN_N:                 40,           // dur — mêmes paires modèle_base vs modèle+feature
FEATURE_MIN_GAIN_MIN_MS:       5 * 60 * 1000, // produit — gain médian minimal pour justifier la complexité
FEATURE_CONFIRM_N:             20,            // dur — bloc de confirmation ULTÉRIEUR et NON-RECOUVRANT
FEATURE_MAX_CONCURRENT_TRIALS: 2,             // produit — discipline anti comparaisons-multiples
```
Procédure : backtester en parallèle *modèle_0* (médiane seule) et *modèle_1* (médiane +
variable candidate) sur les mêmes épisodes ; comparer les erreurs en paires (test des signes
ou Wilcoxon signé sur `erreur_1n - erreur_0n`, pas deux médianes juxtaposées) ; n'adopter que
si le gain dépasse `FEATURE_MIN_GAIN_MIN_MS` **et** se reconfirme sur un bloc ultérieur d'au
moins 20 nouveaux backtests non recouvrants avec ceux qui ont servi à détecter le gain ; ne
jamais tester plus de 2 variables candidates en parallèle.

### 3.11 Explicitement exclu de cette version (mis à jour)

| Exclu | Pourquoi |
|---|---|
| Segmentation par indice de sieste (WW1/WW2/WW3) | Pas de structure de sieste stable avant 10-12 semaines ; contredit la décision C4 déjà actée |
| EWMA à 3 termes 0,5/0,3/0,2 | Poids arbitraires non justifiés ; remplacé par une médiane sur fenêtre glissante |
| Pool cumulatif de tout l'historique | Mélange des régimes de sommeil qui changent chaque semaine ; remplacé par une fenêtre glissante (§3.2-3.3) |
| Moyenne + min/max | Le min/max n'est pas une borne réelle, juste l'accident le plus rare observé ; remplacé par médiane + P25/P75 |
| Coefficient de variation (CV) comme critère de statut | Ratio de deux estimateurs eux-mêmes instables à faible *n* ; remplacé par la performance de backtest mesurée (§3.5-3.6) |
| Test de Spearman pour valider une feature | Association rétrospective en vrac, ne respecte pas l'ordre temporel ; remplacé par comparaison d'erreur de backtest en paires (§3.10) |
| Addition arithmétique des deux plages (P25+P25, P75+P75) pour obtenir la plage de réveil | Non-additivité des quantiles + confondant onset/durée non résolu avant 10-12 semaines ; remplacé par chaînage des médianes + plage mesurée sur le round-trip (§3.4) |
| Score de confiance en % | Fausse précision statistique sur un échantillon bruité |
| API « probabiliste » dès la V1 (p20/p50/p80) | Pertinent pour protéger un contrat multi-clients ; hors sujet pour un projet solo mono-commit |
| Niveau 2 (survie/hazard formalisé) | Sur-sophistication pour un seul bébé ; l'essentiel (quantiles) est déjà intégré au Niveau 1 redéfini |
| Niveau 3+ (GBT, bayésien population, LSTM) | Suppose une infra serveur + dataset multi-bébés qui n'existeront jamais dans ce cadre |
| Mise en cache du résultat en `localStorage`, ou timer dédié au recalcul du prédicteur | Violerait le principe « source de vérité unique, recalcul à la volée » déjà central au projet ; recalcul à la demande suffit (§3.7) |

### 3.12 Évolution possible plus tard (conditions précises)

- **Segmentation par tranche horaire (matin/après-midi/soir)**, pas par indice de sieste :
  envisageable à partir de **12 semaines** si un motif visuel apparaît réellement, et
  seulement si chaque tranche a `n ≥ 8` (sinon dégradation automatique vers le pool global).
  Bénéficierait aux deux prédicteurs (§3.2, §3.3), la durée de sommeil en particulier.
- **Indice de sieste au sens propre** : seulement si le nombre de dodos/jour (`C3`, déjà
  calculé) se stabilise sur plusieurs semaines glissantes — pas avant 12 semaines non plus.
- **Ajustement sieste précédente / heure du jour / autres features** : via la procédure de
  validation par backtest du §3.10, pas avant.
- **Niveau 3+** : aucune condition ne le débloquera jamais dans ce projet tel que défini. À
  consigner explicitement dans `SPECS-stats.md` pour éviter qu'un futur « ça serait cool
  d'essayer » ne remette le sujet sur la table sans nouveau contexte de projet (ex. si l'app
  devenait un jour multi-utilisateurs — ce qui n'est pas le plan).

---

## 4. Résumé condensé pour prise de décision

**Le fait central, inchangé** : votre bébé a 7 jours ; le domaine sommeil n'est fiable que
depuis 2 jours. Toute segmentation façon WW1/WW2/WW3 ou ajustement fin reste prématuré, pour
la même raison qu'avant : le phénomène visé n'a pas encore de structure stable à cet âge. Ce
fait justifie toujours de s'attendre à un signal bruyant les premières semaines (§1) — il ne
justifie plus de **cacher** ce signal bruyant : depuis la mise à jour n°3 (§0), on l'affiche
avec un badge de confiance honnête plutôt que de le masquer en attendant qu'il mûrisse.

**Ce qui change dans cette révision** — cumul des deux contre-analyses (ChatGPT vérifiée, et
votre correction de cadrage du 13 août) :

| Avant | Maintenant |
|---|---|
| Pool cumulatif depuis le premier jour | Fenêtre glissante (14 jours / 40 échantillons max) — §3.2-3.3 |
| Moyenne + écart-type + min/max | Médiane + P25/P75 — §3.2-3.3 |
| Statut catégoriel basé sur le coefficient de variation | Performance mesurée par **backtesting individuel** (walk-forward) — §3.5-3.6 |
| Seuil d'âge 42 jours présenté comme physiologique | Puis seuil 56 jours requalifié en **choix produit** (§1) ; **désormais retiré comme condition d'affichage** — l'âge est un contexte informatif affiché, il ne bloque plus rien — §1, §3.1 |
| Validation de feature par test de Spearman | Comparaison d'erreur de backtest en paires, avec garde-fous anti sur-ajustement — §3.10 |
| Rien de visible avant le déblocage | **Nouveau 4e onglet « Prédiction »**, en mode laboratoire — visible dès le premier backtest, **et chaque estimation à l'intérieur s'affiche elle aussi dès n=1**, sans mur — §3.8 |
| Gating à 4 axes cumulatifs par revendication (âge/jours/échantillons/backtests) avant d'afficher un chiffre | **Retiré** (mise à jour n°3, §0) : badge de confiance continu 🌱/🧪/✅ basé sur *n*, affiché À CÔTÉ du chiffre, jamais à sa place — §3.1, §3.6 |
| Calcul lui-même gaté par âge/volume, affichage gaté par la performance mesurée | Le **calcul démarre dès maintenant** ; **l'affichage aussi** — plus aucune étape n'est gatée par l'âge, le volume ou la performance mesurée — §0, §3.5 |
| Plage de réveil masquée si la dispersion de la durée de sommeil est disproportionnée (`SD_MAX_IQR_MEDIAN_RATIO`) | Plage **toujours affichée**, avec une mention « ⚠️ plage large » accolée quand ce seuil est franchi — §3.3 |
| **Un seul prédicteur (écart d'éveil → « prochain réveil »)** | **Deux prédicteurs chaînés** : écart d'éveil → endormissement (§3.2), durée de sommeil → réveil (§3.3) — toute la plage de sommeil, pas seulement le réveil |
| **Estimation affichée en durée seule** (« ≈ 67 min d'éveil ») | **Convertie en heure d'horloge** (« endormissement estimé vers 08:27 ») — §3.9 |
| Un seul backtest, une seule mesure de qualité | **Deux backtests indépendants** (un par prédicteur) + une **3e mesure diagnostique** (round-trip chaîné), jamais un gate, seulement la source de la plage de réveil affichée — §3.4-3.6 |
| *(non traité)* | **Cadence de recalcul explicite** : à la demande à l'ouverture de l'onglet (comme `renderStats()`), rafraîchissement léger 60s pour l'affichage relatif au temps qui passe (extension du timer déjà existant, `app.js:1836`) — §3.7 |

**Ce qui ne change pas** : aucune segmentation par sieste, pas d'EWMA, pas d'ajustement
sieste-précédente sans validation, pas de score de confiance en %, pas d'API probabiliste
V1, pas de Niveau 2/3+ formalisé, pas de nouveau champ dans le schéma d'événement, pas de
mise en cache en `localStorage`, pas de timer dédié au recalcul du prédicteur. Le principe
central reste le même dans son esprit mais change dans sa forme exacte depuis la mise à jour
n°3 (§0) : afficher une plage dès qu'elle est calculable (*n* ≥ 3), un point central seul en
dessous (*n* = 1-2, faute d'assez de données pour une plage réelle), jamais un chiffre de
confiance flatteur ni une heure ponctuelle *alors qu'une plage serait calculable* — et
toujours **une heure d'horloge plutôt qu'une durée**, pour les deux bouts du sommeil.

**Réponse directe à « quelle plage/fréquence de recalcul ? »** (détail en §3.7) : recalcul
**à la demande** (ouverture/bascule de l'onglet Prédiction, même déclencheur que Stats
aujourd'hui) pour la fenêtre glissante et les backtests — pas de timer ; la fenêtre glissante
est bornée (donc trivialement négligeable), le rejeu des backtests parcourt tout
l'historique sans être borné mais reste négligeable en pratique au volume d'un seul bébé
(§3.5, §3.7). En plus de ça, un rafraîchissement léger
**toutes les 60s**, réservé au texte relatif au temps qui passe (« estimé dans 12 min » /
« en retard de 8 min »), en étendant le seul timer déjà présent dans le code
(`app.js:1836`) à `currentView === 'prediction'` — sans jamais lui faire recalculer le
prédicteur lui-même.

**Ce qu'on fait dès maintenant (coût faible)** :
- Écrire dans `stats.js` les deux prédicteurs (fenêtre glissante, médiane/P25/P75) : un pour
  l'écart d'éveil (§3.2), un pour la durée de sommeil (§3.3) — même contrat que
  `Stats.compute`, réutilisant `_resolveSleep`.
- Démarrer les **deux backtests silencieux** (§3.5) dès aujourd'hui — le domaine sommeil
  est fiable depuis le 11 août, donc il n'y a aucune raison d'attendre pour commencer à
  logger (erreur, date, âge) à chaque nouvel épisode, pour les deux prédicteurs.
- Construire le **4e onglet « Prédiction »** (§3.8) — visible dès qu'il y a ≥ 1 point de
  donnée sur au moins un des deux prédicteurs, clairement étiqueté expérimental, chaque
  chiffre accompagné de son badge 🌱/🧪/✅ ; recalcul à l'ouverture d'onglet, pas de timer
  dédié (§3.7).
- Ajouter les constantes nommées listées en §3.2/§3.3/§3.5/§3.10.

**Où vit ce code exactement (précision technique absente des sections précédentes).**
Tout — constantes et logique — s'ajoute comme propriétés du `const Stats = { ... }` déjà
existant dans `stats.js` (même objet qui porte déjà `Stats.compute`, `Stats._resolveSleep`,
`Stats.sleepSegments`), pas un nouveau module séparé. Point d'entrée unique proposé :
```js
Stats.sleepPrediction(allEvents, opts)
```
même contrat d'appel que `Stats.compute(Store.all(), opts)` (`allEvents` = tous les
événements, filtrage par `DATA_START.sommeil` fait à l'intérieur, pas par l'appelant). La
forme de l'objet retourné n'a pas besoin d'être inventée séparément : elle est déjà
spécifiée, champ pour champ, par les entrées de `STATES` dans `mockup-prediction.html`
(§3.8) — `{ onset: {median,p25,p75,n} | null, duration: {...} | null, quality1:
{backtestN,errors,medianErr,p80Err}, quality2: {...}, roundtrip: {n, p25Err?, p75Err?},
table1: [{pred,real,errMin}], table2: [...] }`, plus `ageDays`/`reliableDays`/`lastWake` pour
le contexte. `renderPrediction()` dans `app.js` peut réutiliser quasi tel quel les fonctions
de rendu du mockup (`renderContext`, `renderOnsetBlock`, `renderWakeBlock`,
`renderQualityInto`, `renderTable`, `tierBadge`) : elles sont déjà la référence de comment
chaque champ doit être consommé et affiché — les copier/adapter plutôt que réinventer un
rendu différent depuis la description en prose du §3.8-3.9.

**Ce qu'on n'affiche jamais ailleurs que dans l'onglet Prédiction, indépendamment de tout
seuil d'âge ou de volume** (§3.8) : toute tendance de sommeil dans l'onglet Suivi, toute
notification. Ce n'est plus une question de maturité mais de canal — le bandeau factuel
existant dans le Suivi (« ⏱ Xmin » / « il y a Xh ») reste inchangé ; seul l'onglet
Prédiction montre des estimations, sans condition d'âge ou de volume pour y accéder, avec
son propre avertissement permanent rappelant leur caractère expérimental.

**Décisions prises — prêt à implémenter directement, pas de question bloquante restante**
(historique des questions qui étaient encore ouvertes avant la mise à jour n°3, et comment
elles ont été tranchées) :
1. ~~Seuil d'âge de 56 jours pour déclencher l'affichage hors onglet Prédiction~~ —
   **RÉSOLU (§0, §1, §3.1) : retiré.** Aucun seuil d'âge ne déclenche ni ne bloque plus
   aucun affichage ; l'âge reste affiché comme contexte informatif seulement.
2. Les seuils numériques du document (fenêtres 14j/40 échantillons, paliers de confiance
   20/40 backtests) sont les valeurs par défaut à implémenter telles que documentées en
   §3.2/§3.3/§3.5 — ce ne sont plus des conditions d'affichage mais des tailles de fenêtre
   et des bornes de badge, ajustables plus tard si le backtest lui-même (une fois en place)
   suggère qu'elles sont mal calibrées pour ce bébé.
3. Le contenu de l'onglet Prédiction à implémenter est celui du §3.8 (carte contexte,
   estimations endormissement + réveil en heure d'horloge avec badge, deux cartes qualité de
   backtest, deux tableaux prédiction/réalité), avec les textes exacts du §3.9. Le mockup
   [mockup-prediction.html](mockup-prediction.html) montre le rendu cible à trois stades de
   maturité — s'y référer directement plutôt que ré-interpréter la description en prose.
4. ~~Le garde-fou `SD_MAX_IQR_MEDIAN_RATIO` masque la plage de réveil quand elle est trop
   dispersée~~ — **RÉSOLU (§0, §3.3) : ne masque plus rien.** La plage s'affiche toujours ;
   ce seuil déclenche uniquement une mention « ⚠️ plage large » accolée.
5. La cadence de recalcul à implémenter est celle du §3.7 : recalcul à la demande à
   l'ouverture/bascule de l'onglet (aucun timer dédié), plus l'extension du timer 60s déjà
   existant (`app.js:1836`) au cas `currentView === 'prediction'` pour le texte relatif au
   temps qui passe uniquement.
6. Documentation annexe optionnelle, non bloquante pour l'implémentation : consigner ces
   décisions dans `SPECS-stats.md` (nouvelle section « C5 ») dans le même style que les
   décisions du 2026-08-11, si une trace y est aussi voulue en plus de ce document.
7. Ce document constitue la demande d'implémentation elle-même : la plomberie invisible
   (§3.2-§3.6 — deux fenêtres glissantes, deux backtests silencieux, le diagnostic
   round-trip) et l'onglet visible (§3.8-§3.9) sont tous les deux à construire, dans cet
   ordre logique (la plomberie doit exister avant que l'onglet ait quelque chose à lire).
