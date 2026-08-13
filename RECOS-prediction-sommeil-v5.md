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

>
> **Mise à jour n°4, même jour.** Relecture statistique finale avant implémentation :
> quatre corrections structurantes sont intégrées. (1) Le round-trip conserve désormais
> les **résidus signés** pour construire la plage de réveil ; les erreurs absolues restent
> réservées aux métriques de performance (§3.4-3.5). (2) La prédiction distingue
> explicitement l'état **éveillé** de l'état **déjà endormi** : dès que l'heure réelle
> d'endormissement est connue, elle remplace l'heure prédite comme origine du calcul de
> réveil (§3.4). (3) Les badges 🌱/🧪/✅ sont renommés en badges de **recul / maturité des
> données**, jamais de « confiance » ni de qualité : la qualité est mesurée séparément par
> l'erreur de backtest (§3.6). (4) Tous les seuils numériques autres que `n=0` sont
> explicitement requalifiés en **choix produit**, y compris `n=3`, 20 et 40.
>
> Cette mise à jour ajoute aussi une **timeline d'évolution expérimentale** (§3.13), avec
> des rendez-vous de test à certaines semaines d'âge et une petite suggestion in-app
> lorsqu'un test devient pertinent. Point crucial : **la semaine n'active jamais
> automatiquement un nouvel algorithme** ; elle ouvre seulement un candidat à tester. Une
> évolution n'est adoptée que si son walk-forward bat la baseline puis confirme le gain sur
> des données ultérieures non recouvrantes. Cette timeline et sa notification sont ici une
> **spécification de conception uniquement : rien de cette mécanique n'est à coder dans la
> présente étape**.


> **Mise à jour n°5, même jour — laboratoire Champion / Challengers + export LLM.** Le
> calendrier S4/S6/S8/S10 est recadré une dernière fois : ces semaines ne sont **plus des
> dates de début de calcul ni d'implémentation d'une variable**. Les candidats autorisés
> sont calculés et backtestés en *shadow mode* dès qu'ils sont mathématiquement calculables,
> sans modifier la prédiction principale. Les semaines deviennent des **checkpoints de
> lecture humaine** : elles attirent l'attention sur un volume de comparaisons qui commence
> à devenir interprétable, mais la décision d'adopter ou non reste entièrement humaine.
>
> L'onglet « Prédiction » devient donc un véritable laboratoire **Champion / Challengers** :
> M0 reste la baseline ; M1–Mx affichent leur prédiction actuelle, leur erreur walk-forward,
> leur biais signé, leur gain apparié par rapport à M0 et surtout **l'évolution de ce gain
> dans le temps**. Une amélioration passe conceptuellement par les états `collecting` →
> `shadow` → `exploration` → `confirming` → décision humaine (`active` ou `rejected`) ;
> aucune promotion automatique n'est autorisée. Les modèles mono-variable sont observés
> avant tout modèle combiné, afin de conserver une attribution lisible du gain.
>
> Enfin, un **export JSON versionné et auto-descriptif pour analyse par LLM** est spécifié
> (§3.14). Il contient dans un seul fichier les définitions des modèles, conventions de
> signe, prédictions actuelles, métriques appariées, séries hebdomadaires, checkpoints,
> statuts d'expériences et cas individuels avec leurs features dérivées. Le format est
> volontairement JSON plutôt que CSV : les données ont plusieurs niveaux reliés entre eux
> et doivent rester compréhensibles lorsqu'elles sont fournies seules à un LLM. Par défaut,
> l'export est limité au domaine sommeil et ne contient ni nom ni date de naissance exacte.
> **Tout ce qui est ajouté par cette mise à jour est une spécification : rien n'est codé à
> ce stade.**

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
calculés à la main sur des tableaux JS. Côté interface : un 4e onglet dédié « Prédiction » (§3.8), conçu comme un laboratoire
Champion / Challengers ; les modèles candidats, checkpoints et export LLM sont spécifiés en
§3.10 et §3.12-§3.14.

**La règle qui prime sur tout le reste de ce document : ne jamais rien cacher.** Une
version antérieure de cette spec imposait un système de portes (« gating ») qui bloquait
tout affichage tant que l'âge du bébé, le volume de données et la performance mesurée du
backtest n'avaient pas simultanément franchi des seuils élevés (56 jours, 14 jours civils,
20 échantillons récents, 40 backtests récents). **Cette logique de portes a été retirée**
(décision produit explicite : app strictement personnelle, l'utilisateur sait déjà que les
chiffres sont approximatifs et préfère les voir tôt). Si vous lisez plus loin et tombez sur
une formulation qui semble décrire un mur d'attente, un état « pas encore assez de recul »
qui masquerait un chiffre, ou un seuil qui empêcherait un affichage — c'est soit un résidu
qui a échappé à la relecture (signalez-le), soit l'unique impossibilité mathématique réelle :
- **n = 0** (aucune donnée) : rien à afficher, littéralement impossible à calculer.

Le seuil **n < 3** utilisé plus loin pour ne pas afficher P25/P75 n'est pas mathématique :
on pourrait calculer des quantiles sur 1 ou 2 points selon une convention d'interpolation.
C'est un **choix produit de lisibilité** : avec si peu de points, la plage empirique n'ajoute
pratiquement aucune information au chiffre central. En dehors de `n=0`, tout ce qui est
calculable **s'affiche**, accompagné d'un badge de **recul / maturité des données**
(🌱 peu de recul / 🧪 recul intermédiaire / ✅ recul important — détail en §3.6) qui informe
sans jamais se faire passer pour une mesure de précision.

**Où regarder si vous codez à partir de ce document.** §3.2 et §3.3 pour les deux
prédicteurs (formules, fenêtres glissantes, constantes), §3.4 pour le chaînage des deux en
une plage de sommeil complète, §3.5 pour le mécanisme de backtesting silencieux, §3.6 pour
la règle d'affichage continu et les badges de recul, §3.7 pour la cadence de recalcul
(quand recalculer, avec quel timer), §3.8-§3.9 pour l'UI concrète de l'onglet et les textes
français exacts à afficher à différents stades, §3.12-§3.14 pour le laboratoire Champion / Challengers, les checkpoints,
les suggestions in-app et l’export LLM (spécifiés mais non codés), §4 pour un
résumé condensé et la liste
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
| Fenêtre d'éveil personnalisée, présentée en plage | ✅ Gardé (principe) | Cohérent avec la philosophie du projet ; affichée dès qu'elle est calculable, avec un badge de recul qui reflète le volume de données (voir §3.1) |
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
affichés à côté de l'estimation (carte « contexte », §3.8), et la base du badge de recul
continu décrit en §3.6.

| Axe | Nature | Rôle maintenant |
|---|---|---|
| Âge depuis la naissance (6 août 2026, 5h25) | Contexte informatif, pas une frontière physiologique (§1) | Affiché tel quel (« bébé a X jours ») ; n'influence plus l'affichage |
| Volume — jours fiables depuis `DATA_START.sommeil` | Contexte informatif | Affiché tel quel (« X jours de sommeil suivis ») ; n'influence plus l'affichage |
| Volume — échantillons dans la fenêtre récente | Détermine la quantité d'information affichée (§0) | Sous 1 : rien. À n=1-2 : médiane seule par choix produit. À partir de n=3 : médiane + plage, badge de recul basé sur ce *n* (§3.6) |
| Volume — backtests dans la fenêtre récente | Mesure le recul dont on dispose pour évaluer la performance (§3.5-§3.6) | Toujours affiché dès le 1er backtest ; le badge (🌱/🧪/✅) reflète *n*. La qualité elle-même est le niveau d'erreur, affiché séparément |

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
pas de cacher le chiffre (§0) : elle justifie de l'accompagner d'un badge de recul
honnête (🌱/🧪/✅, §3.6) plutôt que de le remplacer par un silence. Concrètement :
`endormissement_prévu` s'affiche dès *n*=1 (la médiane d'un seul point est ce point-là —
trivial mais réel), `intervalle_affiché` s'y ajoute dès *n* ≥ `WW_MIN_SAMPLES_FOR_RANGE`
(3).

```js
// Constantes nommées à ajouter dans stats.js. Tous les seuils numériques ci-dessous sont
// des choix produit/documentés, pas des frontières mathématiques ou physiologiques.
// L'unique impossibilité mathématique d'affichage reste n=0 (§0). Aucune constante ne cache
// l'estimation ; voir §3.6 pour le rôle des compteurs dans le badge de recul.
WAKE_GAP_MAX_MS:            12 * 60 * 60 * 1000, // produit — filtre de saisie, inchangé
WW_WINDOW_DAYS:             14,                   // produit — fenêtre glissante
WW_WINDOW_MAX_SAMPLES:      40,                    // produit — plafond de la fenêtre
WW_MIN_SAMPLES_FOR_RANGE:   3,                     // produit — sous ce seuil, on choisit de n'afficher que la médiane ; les quantiles seraient calculables mais peu informatifs
```

Résolution des épisodes toujours via `_resolveSleep()` ([stats.js:62](stats.js#L62)), écarts
calculés comme en v1 (fin(épisode_i) → début(épisode_i+1)), dodos en cours et écarts
négatifs exclus. Aucun changement du schéma d'événement `{ ts, data:{end} }`, aucun champ
`nap_index` stocké — inchangé par rapport à la v1.

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
SD_MIN_SAMPLES_FOR_RANGE:    3,    // produit — même logique que WW_MIN_SAMPLES_FOR_RANGE : quantiles calculables mais volontairement non affichés à n<3
SD_MAX_IQR_MEDIAN_RATIO:     2.5,  // produit — déclenche une mention « ⚠️ plage large » accolée à la plage ; ne masque plus rien (§0)
```
Fenêtres indépendantes plutôt que réutilisation littérale de `WW_*` : la structure
sieste/nuit se consolide vite (rythme circadien émergent, §1), potentiellement plus vite que
l'écart d'éveil ne dérive lui-même — la durée de sommeil a donc plus de raisons de devenir
obsolète rapidement. Démarrer avec les mêmes valeurs (14j/40) est un point de départ
raisonnable ; laisser chaque backtest (pas un raisonnement a priori) dire, plus tard, si la
fenêtre de la durée doit être resserrée indépendamment de celle de l'écart d'éveil.

### 3.4 Assembler la plage complète — et basculer selon l'état réel du bébé

Il y a **deux situations différentes**, et le calcul du réveil ne doit surtout pas utiliser
la même origine dans les deux cas.

#### État A — bébé est éveillé

L'heure d'endormissement n'est pas encore connue. On chaîne donc les deux prédicteurs :

```
endormissement_prévu = dernier_réveil_réel + médiane(W)
réveil_prévu         = endormissement_prévu + médiane(D)
```

Le point central `médiane(W) + médiane(D)` est une estimation opérationnelle ; en revanche,
**on ne construit pas la plage de réveil en additionnant P25+P25 et P75+P75**. Même sous
indépendance, la somme de quantiles marginaux n'est pas le quantile de la somme ; ici, de
plus, heure d'endormissement et durée du sommeil suivant peuvent être dépendantes.

La plage de réveil en état éveillé est donc calibrée sur les **résidus signés du backtest
round-trip** (§3.5) :

```
RT_signed = réveil_réel - réveil_prévu

réveil_bas  = réveil_prévu + P25(RT_signed)
réveil_haut = réveil_prévu + P75(RT_signed)
```

C'est volontairement asymétrique. Si le système prédit historiquement les réveils trop tôt,
les deux quantiles signés peuvent être positifs et déplacer toute la plage vers plus tard ;
une erreur absolue aurait détruit cette information de biais.

**Fallback avant le premier round-trip mesuré (`n(RT_signed)=0`)** : conserver la solution
provisoire déjà prévue — addition des deux intervalles marginaux — mais uniquement comme
ordre de grandeur explicitement étiqueté *« approximation grossière, pas encore calibrée
sur des prédictions passées »*. Dès le premier round-trip disponible, ce fallback disparaît.

#### État B — bébé est déjà endormi

Dès qu'un événement de sommeil réel est ouvert, l'heure d'endormissement n'est plus une
variable à prédire : **elle est connue**. Toute estimation de réveil qui continuerait à
partir de l'endormissement prédit serait une perte d'information.

```
réveil_prévu = endormissement_réel + médiane(D)
réveil_bas   = endormissement_réel + P25(D)
réveil_haut  = endormissement_réel + P75(D)
```

Ici, translater les quantiles de `D` par une constante est parfaitement valide : on
n'additionne plus deux variables aléatoires, on ajoute simplement l'heure réelle de début à
la distribution empirique des durées de sommeil.

La qualité à afficher pour ce réveil est donc celle du **backtest du prédicteur de durée**
(`E_wake`), pas celle du round-trip. Le round-trip reste utile uniquement quand le bébé est
éveillé et que les deux étages doivent réellement être chaînés.

**Cas où le sommeil en cours dépasse déjà la plage historique affichée.** La V1 ne doit pas
inventer un recalcul de survie : elle garde l'information factuelle *« sommeil en cours
depuis X »* et peut indiquer *« au-delà de la plage habituelle »*. Une amélioration candidate
`remaining sleep` conditionnelle à la durée déjà écoulée est explicitement prévue dans la
timeline (§3.13) ; elle ne fait pas partie de la V1.

En résumé, la logique d'état cible est :

```
AWAKE  -> predictSleepOnset() + predictWakeRoundTrip()
ASLEEP -> actualSleepStart + predictSleepDuration()
```

Le passage de `AWAKE` à `ASLEEP` invalide immédiatement l'endormissement prédit comme origine
du réveil : l'UI doit se recalculer depuis l'heure d'endormissement réelle au prochain rendu.


### 3.5 Le backtesting silencieux — deux prédicteurs indépendants, plus un diagnostic round-trip

La question qui compte n'est pas *« les données sont-elles peu dispersées ? »* mais
*« le prédicteur, lorsqu'il ne connaissait pas encore la réponse, se trompait de combien ? »*.
Le backtest est donc une validation glissante dans le temps (*walk-forward*) sans fuite du
futur.

Il faut **deux backtests indépendants** — un pour l'endormissement, un pour la durée de
sommeil — plus un troisième diagnostic chaîné. Deux prédicteurs biaisés peuvent en effet se
compenser artificiellement sur le réveil final ; le round-trip ne remplace donc jamais les
deux métriques élémentaires.

```
Pour chaque nouvel épisode d'éveil g_n :
  W_(n) = fenêtre récente calculée UNIQUEMENT sur g_1..g_(n-1)
  si n(W_(n)) >= BACKTEST_MIN_TRAIN_SAMPLES :
      pred_onset_n = médiane(W_(n))
      err_onset_n  = g_n - pred_onset_n

Pour chaque nouvel épisode de sommeil d_n :
  D_(n) = fenêtre récente calculée UNIQUEMENT sur d_1..d_(n-1)
  si n(D_(n)) >= SD_BACKTEST_MIN_TRAIN_SAMPLES :
      pred_duration_n = médiane(D_(n))
      err_duration_n  = d_n - pred_duration_n

Round-trip, lorsque les DEUX prédictions existaient avant observation :
  réveil_prévu_n = (dernier_réveil + pred_onset_n) + pred_duration_n
  err_RT_signed_n = réveil_réel_n - réveil_prévu_n
```

**Conserver impérativement le signe du round-trip.** Deux vues sont dérivées des mêmes
résidus :

```
RT_signed = { err_RT_signed_n récents }
RT_abs    = { |err_RT_signed_n| récents }
```

- `RT_signed` sert à **calibrer la plage de réveil** lorsque bébé est éveillé :
  `réveil_prévu + P25(RT_signed)` à `réveil_prévu + P75(RT_signed)` (§3.4).
- `RT_abs` sert uniquement à **mesurer la performance** : erreur absolue médiane, P80,
  graphique d'erreurs.

La même séparation « erreur signée pour diagnostiquer le biais / erreur absolue pour dire
combien on se trompe » peut être conservée pour les deux prédicteurs élémentaires, même si
la V1 n'utilise leurs résidus signés que pour le diagnostic.

Fenêtres de qualité récentes :

```
E_onset_abs = |err_onset| sur les BACKTEST_TIER_SOLID_N backtests les plus récents
E_wake_abs  = |err_duration| sur les SD_BACKTEST_TIER_SOLID_N backtests les plus récents
RT_signed   = err_RT_signed sur les RT_TIER_SOLID_N round-trips les plus récents
RT_abs      = |RT_signed|
```

Les seuils ci-dessous sont des **choix produit initiaux**, pas des seuils mathématiques :

```js
BACKTEST_MIN_TRAIN_SAMPLES:    3,   // produit — baseline volontairement très précoce
BACKTEST_TIER_EMERGING_N:      20,  // produit — borne de recul, pas de qualité
BACKTEST_TIER_SOLID_N:         40,  // produit — borne de recul + taille max de la vue récente
SD_BACKTEST_MIN_TRAIN_SAMPLES: 3,   // produit
SD_BACKTEST_TIER_EMERGING_N:   20,  // produit
SD_BACKTEST_TIER_SOLID_N:      40,  // produit
RT_TIER_EMERGING_N:            20,  // produit
RT_TIER_SOLID_N:               40,  // produit
```

**Démarrage : dès maintenant.** Les backtests se reconstruisent à partir de l'historique
fiable depuis `DATA_START.sommeil`. Ils ne sont jamais persistés séparément : à chaque
ouverture de l'onglet Prédiction, le walk-forward rejoue l'historique et reconstruit les
résidus. Le volume d'un seul bébé rend ce coût négligeable ; cette logique conserve la
source de vérité unique et évite tout cache dérivé.


### 3.6 Affichage continu — séparer clairement **recul** et **performance**

Le badge de recul 🌱/🧪/✅ ne doit plus s'appeler « confiance » : il dépend uniquement du nombre de
points disponibles et indique donc le **recul / la maturité des données**, pas la précision
du modèle. Un prédicteur peut avoir 50 backtests et rester très mauvais ; dans ce cas son
recul est important, mais sa performance mesurée est mauvaise.

Règle d'affichage :

```
n = 0                        -> rien à calculer
n >= 1                       -> afficher le chiffre central
n >= MIN_SAMPLES_FOR_RANGE   -> afficher aussi la plage (choix produit, valeur initiale 3)
```

Badge de recul générique :

```
n < 20       -> 🌱 « peu de recul (n=X) »
20 <= n < 40 -> 🧪 « recul intermédiaire (n=X) »
n >= 40      -> ✅ « recul important (n=X) »
```

Les valeurs 20/40 sont des **paliers produit arbitraires et ajustables**. Elles ne doivent
jamais être utilisées pour écrire « prédiction fiable » ou « confiance élevée ».

La **performance**, elle, est toujours affichée séparément à partir du walk-forward :

```
Erreur absolue médiane : 11 min
80 % des erreurs : <= 19 min
Backtests récents : n=40
```

Application concrète :

- estimation d'endormissement : badge de recul basé sur `onset.n` ; performance basée sur
  `E_onset_abs` ;
- estimation de durée/réveil : badge de recul basé sur `duration.n` ; performance basée sur
  `E_wake_abs` ;
- plage de réveil chaînée lorsque bébé est éveillé : badge de recul basé sur `RT_signed.n`,
  performance round-trip basée sur `RT_abs` ;
- lorsque bébé est déjà endormi, la plage vient directement de `D` (§3.4) et le round-trip
  n'est plus le bon indicateur de qualité pour ce réveil en cours.

Formulations UI recommandées :

```
🌱 peu de recul (n=8)
🧪 recul intermédiaire (n=27)
✅ recul important (n=45)
```

et, sur une ligne distincte :

```
Performance observée : erreur médiane 22 min · 80 % <= 39 min
```

Cette séparation empêche le principal malentendu UX de la version précédente : un ✅ ne
dit jamais que la prédiction est bonne ; il dit uniquement qu'on dispose d'assez de recul
pour juger plus sérieusement si elle est bonne ou mauvaise.


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
2. **Rafraîchissement léger** (comparaison « il est actuellement HH:MM, prochain événement
   estimé à HH:MM, donc dans X min / plage dépassée », compteur ⏱ depuis le dernier réveil
   si bébé est éveillé ou depuis l'endormissement réel s'il dort) :
   étendre la garde du timer existant à `currentView === 'prediction'`, même cadence de 60s,
   sans recalculer le prédicteur — juste rafraîchir l'écart entre l'heure actuelle et
   l'estimation déjà calculée. Aucune nouvelle primitive : cadence déjà validée dans ce
   projet pour un besoin analogue.

Ne pas ajouter de recalcul déclenché par mutation (`Store.add`/`update` → recalcul
immédiat) : ça compliquerait le flux d'écriture pour un gain invisible tant que l'onglet
n'est pas affiché, et le recalcul à l'ouverture couvre déjà le cas qui compte (le parent
ouvre l'onglet, voit des chiffres à jour).

### 3.8 Onglet « Prédiction » — laboratoire **Champion / Challengers**

L'onglet n'est plus seulement un écran de prédiction et de backtest de la baseline : il doit
permettre à l'utilisateur de **voir lui-même ce que chaque évolution change**, avant toute
décision d'implémentation ou de promotion. La philosophie devient :

> **Tout calculer tôt. Tout comparer en walk-forward. Tout montrer. Ne rien promouvoir
> automatiquement.**

Le modèle utilisé comme référence est appelé **Champion** (`M0`). Toutes les variantes sont
des **Challengers** (`M1…Mx`) et tournent en *shadow mode* dès qu'elles sont calculables :
elles produisent une prédiction et un backtest, mais n'ont aucun effet sur la prédiction
principale tant qu'une décision humaine ne les a pas explicitement promues.

**Ce qui reste inchangé côté canal** : aucune estimation n'est poussée dans l'onglet Suivi,
aucune Web Notification / push. Les seules alertes futures autorisées sont les suggestions
**in-app** de revue expérimentale du §3.13. Elles attirent l'attention sur des résultats ;
elles ne changent jamais un modèle.

#### 3.8.1 Vue « Maintenant » — comparer les sorties, pas seulement le champion

Lorsque bébé est éveillé, afficher côte à côte les prédictions d'endormissement des modèles
qui savent produire cette cible ; lorsque bébé dort, afficher les prédictions de réveil
compatibles avec l'état `ASLEEP`. Exemple de structure :

| Modèle | Prédiction actuelle | Écart vs M0 | Recul | Statut |
|---|---:|---:|---:|---|
| **M0 — baseline** | 15:12 | — | n=28 | `active` |
| M1 — récence | 15:06 | -6 min | n=28 | `shadow` |
| M3 — heure | 14:58 | -14 min | n=17 | `shadow` |
| M4 — sommeil précédent | 15:18 | +6 min | n=15 | `collecting/shadow` |

L'écart de prédiction indique seulement que les modèles **pensent différemment**. Il ne dit
rien sur lequel a raison. Cette table doit donc être visuellement reliée aux métriques de
backtest décrites juste après.

La carte de la baseline conserve le rendu AWAKE/ASLEEP du §3.4 :
- `AWAKE` : onset prévu + wake prévu chaîné ;
- `ASLEEP` : `actualSleepStart` remplace définitivement l'onset prédit comme origine du
  réveil de M0.

Pour les challengers, chaque modèle expose explicitement la ou les cibles qu'il sait
prédire (`onset`, `wake`, `remainingWake`) ; afficher `— non applicable` plutôt que fabriquer
une valeur lorsqu'un modèle ne concerne pas cette cible.

#### 3.8.2 Vue « Performance » — la comparaison appariée est centrale

Pour chaque modèle et chaque cible, afficher au minimum :

- **erreur absolue médiane** walk-forward ;
- **P80 de l'erreur absolue** ;
- **biais signé médian**, avec convention fixe `réalité - prédiction` : positif = le réel
  arrive plus tard que prévu, négatif = plus tôt ;
- nombre de backtests `n` et badge de **recul** (§3.6) ;
- pour un challenger : **gain apparié vs M0** sur exactement les mêmes épisodes.

Définition du gain par épisode :

```text
gain_i(Mx) = abs(erreur_i(M0)) - abs(erreur_i(Mx))
```

Donc :
- `gain > 0` = le challenger est meilleur ;
- `gain = 0` = égalité ;
- `gain < 0` = le challenger est pire.

Résumé challenger recommandé :

```text
M3 — contexte horaire
n comparable        : 30
MAE médiane M0      : 19 min
MAE médiane M3      : 12 min
gain médian vs M0   : +7 min
M3 meilleur         : 21 / 30 épisodes
biais médian M3     : +2 min
10 derniers cas     : gain médian +9 min
```

Le **taux de victoire** (`challengerWins / pairedN`) est descriptif, pas un test
statistique et jamais un critère de promotion à lui seul.

#### 3.8.3 Vue « Évolution » — voir *quand* une variable commence à apporter quelque chose

C'est le cœur de la demande produit. Le laboratoire doit garder une série temporelle
reconstruite à partir du walk-forward et permettre de voir, par semaine d'âge ou par bloc de
cas, comment les performances changent.

Pour chaque challenger, afficher une courbe ou une table de :

- erreur absolue médiane de M0 ;
- erreur absolue médiane de Mx ;
- **gain médian apparié Mx vs M0** ;
- biais signé de Mx ;
- `pairedN` du bloc.

Exemple de lecture attendue :

| Âge | Gain M1 récence | Gain M2 remaining | Gain M3 heure | Gain M4 précédent |
|---|---:|---:|---:|---:|
| S4 | +2 min | +8 min | -1 min | — |
| S5 | +3 min | +11 min | +1 min | — |
| S6 | +4 min | +13 min | +3 min | +1 min |
| S7 | +3 min | +14 min | +6 min | +2 min |
| S8 | +5 min | +12 min | **+9 min** | +3 min |

Ce tableau ne constitue pas une promesse de résultats : les valeurs ci-dessus sont
**illustratives**. Son rôle est de permettre une lecture du type : « l'heure ne servait à
rien à S4, puis son gain devient progressivement positif vers S7–S8 ».

Prévoir un sélecteur de métrique pour l'évolution : `gain vs M0` (vue par défaut), `erreur
médiane`, `P80`, `biais signé`. Les séries doivent être calculées **sans fuite du futur** :
une valeur affichée à S6 ne peut utiliser aucune observation apparue après S6.

#### 3.8.4 Snapshots de checkpoints — revoir ce qu'on savait réellement à S4/S6/S8/S10

Conserver des snapshots **reconstructibles**, pas nécessairement persistés : l'utilisateur
doit pouvoir sélectionner `Aujourd'hui`, `S4`, `S6`, `S8`, `S10`, `S12`, etc. et revoir :

- quels modèles étaient calculables à cette date ;
- leurs métriques walk-forward disponibles à cette date ;
- leur gain apparié vs M0 ;
- leur statut expérimental à cette date ;
- les éventuelles suggestions de revue qui auraient été déclenchées.

Il ne faut surtout pas recalculer « S4 » avec un modèle entraîné sur les données de S10 :
cela détruirait précisément l'information que cet écran cherche à montrer.

#### 3.8.5 Vue « Cas par cas » — comprendre *pourquoi* un modèle gagne

Ajouter un tableau détaillé, filtrable par cible et modèle :

| Cas | Réel | M0 | M3 heure | M4 précédent | Meilleur |
|---|---:|---:|---:|---:|---|
| épisode 101 | 14:51 | 14:39 | 14:48 | 14:35 | M3 |
| épisode 102 | 17:14 | 17:05 | 17:13 | 17:00 | M3 |

Chaque ligne doit conserver les **features dérivées connues au moment de la prédiction** :
âge en jours, heure locale, durée du sommeil précédent, durée de l'éveil précédent,
`elapsedSleep` pour les cas ASLEEP, etc. Cela permet de comprendre des effets conditionnels
comme « M3 aide surtout le soir » au lieu de réduire toute la décision à une seule moyenne.

#### 3.8.6 Modèles combinés : seulement après lecture des effets simples

Les challengers mono-variable sont observés d'abord. Un modèle hybride n'est créé qu'après
avoir compris les contributions individuelles. Exemple : si `M3 heure` aide uniquement en
soirée et M0 reste meilleur le matin, un futur `M8 hybrid` peut tester :

```text
si tranche == soirée -> M3
sinon                 -> M0
```

`M8` retourne alors lui-même en `shadow` et doit battre M0 en walk-forward. Ne jamais
transformer directement plusieurs signaux exploratoires en un modèle combiné, sinon il
devient impossible d'attribuer le gain et le risque de sur-ajustement augmente fortement.

#### 3.8.7 UI et intégration technique — cible de conception, pas de code dans cette étape

Le 4e onglet et les composants déjà identifiés dans la v4 restent de bons points d'appui :
`.stat-grid`, `.stat-card`, `statChartBars`, `<details class="stat-details">`, `.quality-box`.
La cible UI est désormais plus riche et doit ajouter :

1. bandeau expérimental permanent ;
2. **Champion / Challengers — Maintenant** ;
3. **Performance comparée** ;
4. **Évolution dans le temps** ;
5. **Checkpoints** ;
6. **Cas par cas** ;
7. **Expériences** (statuts §3.10/§3.12) ;
8. bouton **« Exporter pour analyse LLM (.json) »** (§3.14).

Le mockup HTML antérieur reste **non normatif** après cette mise à jour : il ne représente
ni le laboratoire multi-modèles ni l'export LLM et devra être refait au moment où une
implémentation sera demandée.

**Important : cette section est une spécification.** Ne pas coder le moteur de challengers,
les graphiques multi-modèles, les snapshots ou l'export dans la présente étape.


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
de recul 🌱/🧪/✅ visible à côté de chaque chiffre). Les exemples ci-dessous restent utiles
pour le ton et les ordres de grandeur, mais **le mockup HTML antérieur n'est plus normatif**
après la mise à jour n°4 : il devra être réaligné lors de l'implémentation pour intégrer les
résidus signés, la distinction AWAKE/ASLEEP et le vocabulaire recul/performance. La présente
spec écrite fait foi.

- **J7 — un seul réveil mesuré** (`STATES.j7` : *n*=1 pour l'endormissement, pas encore de
  plage possible tant que *n* < `WW_MIN_SAMPLES_FOR_RANGE` = 3 ; *n*=0 partout ailleurs) :
  > *« 08:12 endormissement 🌙 🌱 — ≈ 72 min d'éveil — une seule mesure, pas encore de plage
  > possible (dès n=3). »* puis, en badge accolé : *« 🌱 peu de recul (n=1) · basé sur
  > 1 réveil récent — expérimental, à prendre avec précaution. »*
  > *« Réveil 🌅 : Aucune durée de sommeil mesurée encore pour ce bébé (n=0) — rien à
  > estimer pour l'instant. »*
  > Les deux cartes « Qualité du backtest » affichent *« — »* et *« Aucun backtest encore
  > (n=0). »* ; les deux tableaux affichent *« Aucune prédiction backtestée encore (n=0). »*
- **~3 semaines** (`STATES.s3` : *n*=18 réveils / 14 backtests pour l'endormissement,
  *n*=16 sommeils / 13 round-trips pour le réveil) :
  > *« 15:13 endormissement 🌙 🌱 — Le plus souvent entre 15:00 et 15:29 (≈ 58 min
  > d'éveil). »* badge : *« 🌱 peu de recul (n=18) · basé sur 18 réveils récents —
  > expérimental, à prendre avec précaution. »*
  > *« Qualité du backtest — endormissement : 24 min d'écart médian 🌱 — 80 % des
  > prédictions à ± 38 min · 14 backtests récents · peu de recul (n=14). »*
  > *« 16:33 réveil 🌅 🌱 — Le plus souvent entre 15:59 et 17:25 (≈ 1 h 20 de sommeil). 🌱
  > plage basée sur 13 round-trips mesurés. ⚠️ plage large : à cet âge, la durée de sommeil
  > mélange siestes courtes et nuits longues — prends ça comme un ordre de grandeur, pas une
  > promesse. »* badge : *« 🌱 peu de recul (n=16) · chaîné à partir de l'endormissement
  > estimé — jamais une addition de deux plages pour le point central. »*
  > *« Qualité du backtest — réveil : 48 min d'écart médian 🌱 — 80 % des prédictions à ±
  > 68 min · 13 backtests récents · peu de recul (n=13). »* note accolée (toujours
  > affichée dès qu'il y a une durée à commenter) : *« Rappel : la durée de sommeil est plus
  > dispersée que l'écart d'éveil à cet âge (siestes et nuits mélangées) — un écart plus
  > grand ici est attendu, pas forcément un bug. »*
- **~9 semaines** (`STATES.s9` : *n*=40 réveils / 40 backtests pour l'endormissement,
  *n*=42 sommeils / 45 backtests / 42 round-trips pour le réveil) :
  > *« 08:27 endormissement 🌙 ✅ — Le plus souvent entre 08:15 et 08:39 (≈ 67 min
  > d'éveil). »* badge : *« ✅ recul important (n=40) · basé sur 40 réveils récents —
  > expérimental, à prendre avec précaution. »*
  > *« Qualité du backtest — endormissement : 11 min d'écart médian ✅ — 80 % des
  > prédictions à ± 19 min · 40 backtests récents · recul important (n=40). »*
  > *« 10:12 réveil 🌅 ✅ — Le plus souvent entre 09:53 et 10:31 (≈ 1 h 45 de sommeil). ✅
  > plage basée sur 42 round-trips mesurés. »* (pas de mention « plage large » : à ce stade
  > l'IQR de la durée de sommeil est redescendu sous `SD_MAX_IQR_MEDIAN_RATIO`) badge :
  > *« ✅ recul important (n=42) · chaîné à partir de l'endormissement estimé — jamais une
  > addition de deux plages pour le point central. »*
  > *« Qualité du backtest — réveil : 22 min d'écart médian ✅ — 80 % des prédictions à ±
  > 39 min · 45 backtests récents · recul important (n=45). »*


**Texte spécifique quand bébé est déjà endormi** — ce cas devient normatif avec la mise à
jour n°4 :

> *« 💤 Endormi depuis 14:47 — réveil estimé vers 16:07. Le plus souvent entre 15:48 et
> 16:32 d'après les durées récentes. »*
>
> *« Recul : 🧪 n=27 · Performance du prédicteur de durée : erreur médiane 24 min · 80 %
> ≤ 41 min. »*

Si l'heure courante dépasse déjà `actualSleepStart + P75(D)`, ne pas afficher « en retard »
comme s'il s'agissait d'un rendez-vous manqué ; préférer :

> *« Sommeil en cours depuis 1 h 52 — au-delà de la plage habituelle observée. »*

La future estimation conditionnelle du temps restant (§3.13, T2) pourra remplacer cette
formulation si elle démontre un gain en backtest ; elle n'est pas à coder dans la V1.

Ce qui n'apparaît **jamais** : un pourcentage de confiance (« confiance : 62 % »), une heure
ponctuelle sans plage une fois que la plage est choisie comme affichable (*n* ≥ 3) sans
mention de fourchette, une plage round-trip définitive obtenue en additionnant deux
intervalles (§3.4), une **notification système/push**, ou un état vide alors qu'au moins un
point de donnée existe (§0). Une petite suggestion **in-app** liée à la timeline expérimentale
est autorisée par exception (§3.13) ; elle ne pousse rien hors de l'application et ne change
jamais l'algorithme automatiquement.

### 3.10 Valider une évolution — **Champion / Challenger**, exploration puis confirmation

Une future feature ne doit plus être évaluée par corrélation rétrospective isolée. La seule
question produit est : **sur les mêmes épisodes, connus dans le même ordre temporel, le
challenger fait-il mieux que le champion ?**

#### Cycle de vie commun de chaque challenger

Chaque variante possède un statut explicite :

```text
collecting  -> shadow -> exploration -> confirming -> active
                                            \-------> rejected
```

- **`collecting`** : la feature est dérivable mais il manque des cas comparables pour
  produire une comparaison utile ; tout ce qui est calculable reste visible.
- **`shadow`** : le challenger produit ses prédictions en parallèle de M0, sans effet sur
  l'UI principale de prédiction.
- **`exploration`** : assez de cas appariés existent pour commencer à lire un signal ; les
  métriques restent explicitement exploratoires.
- **`confirming`** : le candidat et ses paramètres sont **gelés** ; on collecte un bloc
  ultérieur non recouvrant.
- **`active`** : décision humaine explicite de promouvoir la variante après confirmation.
- **`rejected`** : décision humaine de ne pas l'utiliser ; son historique reste visible et
  peut être réexaminé plus tard si le régime de sommeil change.

Aucun statut ne doit être déduit uniquement de l'âge du bébé. Les seuils de volume sont des
choix produit pour structurer la lecture, jamais des frontières biologiques.

#### Comparaison appariée

Pour chaque épisode comparable :

```text
abs0_i  = abs(réel_i - pred_M0_i)
absx_i  = abs(réel_i - pred_Mx_i)
gain_i  = abs0_i - absx_i
biasx_i = réel_i - pred_Mx_i
```

À exposer : médiane(`gain_i`), P25/P75 du gain si utile, taux de victoire, médiane des
`absx_i`, P80 des `absx_i`, médiane des `biasx_i`. Toujours conserver les lignes appariées
pour permettre l'inspection cas par cas et l'export LLM (§3.14).

#### Exploration → confirmation

Constantes produit proposées comme point de départ, ajustables plus tard :

```js
FEATURE_EXPLORATION_MIN_PAIRED_N:  20,
FEATURE_CONFIRM_TRIGGER_N:         40,
FEATURE_MIN_GAIN_MIN_MS:            5 * 60 * 1000,
FEATURE_CONFIRM_N:                 20,
FEATURE_MAX_CONCURRENT_TRIALS:      2,
```

Règle :
1. observer le challenger dès qu'il est calculable ;
2. à partir de suffisamment de paires, lire le gain **sans le promouvoir** ;
3. si le gain paraît pratiquement intéressant (par défaut médiane ≥ 5 min) sur le bloc
   exploratoire, geler la variante et ses paramètres ;
4. la tester sur au moins `FEATURE_CONFIRM_N` **nouveaux** épisodes non recouvrants ;
5. seulement ensuite afficher « amélioration confirmée » ;
6. la promotion finale reste **une décision humaine**, jamais une conséquence automatique
   d'un seuil.

Un test des signes ou Wilcoxon signé peut être ajouté plus tard comme information
secondaire, mais il n'est pas le décideur : sur un seul bébé non stationnaire, la taille de
l'effet, sa stabilité temporelle et la confirmation prospective comptent davantage qu'un
`p-value` isolé.

#### Discipline d'attribution

Tester en priorité **une modification à la fois** contre M0. Exemple :

```text
M0
├─ M1 : récence
├─ M3 : heure de journée
├─ M4 : durée sommeil précédent
└─ M5 : durée éveil précédent
```

Un modèle combiné n'est autorisé qu'après que les effets simples ont été observés et
compris (§3.8.6). Cela ne garantit pas l'absence de sur-ajustement, mais rend les décisions
beaucoup plus interprétables.


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

### 3.12 Catalogue des modèles — baseline et challengers calculés le plus tôt possible

Le calendrier du §3.13 ne décide plus quand un modèle commence à exister. Chaque challenger
ci-dessous doit être **conceptuellement disponible dès maintenant** et passer de
`collecting` à `shadow` dès que ses entrées sont calculables. Le rôle des semaines est de
créer des rendez-vous de lecture, pas d'empêcher le calcul.

| ID | Nom | Cible | Différence par rapport à M0 | Démarrage conceptuel |
|---|---|---|---|---|
| **M0** | Baseline récente | onset + durée/wake | médiane + P25/P75 sur fenêtre 14j/40 | `active` dès V1 |
| **M1** | Récence / fenêtre | onset et durée séparément | compare plusieurs fenêtres fixes (ex. 10/20/30/40 épisodes, 7/14j) | shadow dès que les fenêtres divergent réellement |
| **M2** | Remaining sleep | wake lorsque `ASLEEP` | conditionne la durée restante au fait que `D > elapsedSleep` | shadow dès qu'il existe des épisodes historiques dépassant `elapsedSleep` |
| **M3** | Contexte horaire | onset et/ou durée | ajoute heure/tranche locale comme contexte | collecte/shadow dès les premiers cas, sans conclure tôt |
| **M4** | Sommeil précédent | onset | utilise `previousSleepDuration` | collecte/shadow dès que la paire existe |
| **M5** | Éveil précédent | durée/wake | utilise `previousWakeDuration` | collecte/shadow dès que la paire existe |
| **M6** | Structure de journée | onset/durée | segmentation day/night ou indice de sieste si une structure apparaît | shadow seulement si les sous-groupes sont calculables sans pools vides |
| **M7** | Récence pondérée | onset/durée | médiane/fonction robuste pondérée par récence, demi-vie testée | shadow quand l'historique devient assez long pour comparer |
| **M8+** | Hybrides | selon besoin | combinaison ciblée de challengers déjà compris | uniquement après résultats mono-variable convaincants |

**M2 mérite une note particulière.** Il ne faut pas attendre S6 pour commencer à le
calculer : savoir que bébé dort encore est une information réelle. En revanche, tant que
l'utilisateur veut comparer lui-même les approches, M2 reste un challenger de la baseline
ASLEEP `actualSleepStart + médiane(D)`. L'écran peut donc montrer très tôt que la baseline a
été « dépassée » alors que M2 produit encore une estimation future ; c'est précisément un
cas intéressant à observer avant de décider de le promouvoir.

Chaque modèle doit déclarer au minimum :

```text
id, label, version, status,
targets[], features[], parameters,
firstComparableAt, pairedN,
```

afin que l'UI, les snapshots et l'export LLM parlent tous le même langage.

Toujours exclu : GBT/LSTM/modèle populationnel tant que le projet reste mono-bébé ; ajout
automatique d'une feature parce qu'elle « semble logique » ; modification rétroactive des
paramètres d'un challenger pendant sa phase de confirmation.


### 3.13 Timeline — checkpoints de **lecture**, pas dates de démarrage des modèles

Cette timeline est calculée à partir de la naissance du **6 août 2026 à 5h25**. Toutes les
variantes M1–M7 peuvent déjà collecter/backtester avant leur checkpoint dès que leurs
features sont calculables (§3.12). Le checkpoint sert à dire : **« regarde maintenant ce
que les données racontent »**.

| Âge | Date | Revue proposée | Ce qu'on regarde | Ce que la semaine ne fait PAS |
|---|---|---|---|---|
| **Maintenant** | dès le 13 août 2026 | Démarrer M0 + collecte/shadow des challengers calculables | établir la baseline et commencer l'historique comparatif | attendre artificiellement une semaine pour dériver une feature |
| **S4** | **3 sept. 2026** | **Checkpoint récence — M1** | les variantes de fenêtre divergent-elles enfin ? gain M1 vs M0, stabilité sur les derniers cas | activer M1 automatiquement |
| **S6** | **17 sept. 2026** | **Checkpoint ASLEEP — M2** | le remaining sleep améliore-t-il le réveil, surtout quand M0 a déjà été dépassé ? | commencer M2 seulement à S6 |
| **S8** | **1 oct. 2026** | **Checkpoint heure — M3** | le gain du contexte horaire devient-il positif/stable ? existe-t-il surtout sur certaines tranches ? | supposer qu'un effet circadien apparaît ce jour-là |
| **S10** | **15 oct. 2026** | **Checkpoint mémoire courte — M4/M5** | épisode précédent : gain onset/durée, cas où il aide ou dégrade | ajouter une correction fixe « sieste courte = -X min » |
| **S12** | **29 oct. 2026** | **Checkpoint structure — M6** | une segmentation jour/nuit ou sieste devient-elle réellement utile ? | imposer WW1/WW2/WW3 par âge |
| **S16** | **26 nov. 2026** | **Checkpoint récence adaptative — M7** | une pondération robuste bat-elle les fenêtres fixes ? | introduire des poids arbitraires |
| **Puis /4 semaines** | dès le **24 déc. 2026** | **Revue générale** | champion vs challengers actifs/rejetés, dérive, candidats à retester | complexifier si aucune amélioration nette |

#### Ce que doit montrer chaque checkpoint

Le checkpoint ouvre directement une vue figée/reconstructible du laboratoire (§3.8.4) :

1. prédictions M0/Mx disponibles ce jour-là ;
2. `pairedN` de chaque challenger ;
3. erreur médiane / P80 / biais signé ;
4. gain médian apparié vs M0 ;
5. gain sur les 10 derniers cas (informatif, très volatil) ;
6. évolution hebdomadaire depuis le checkpoint précédent ;
7. meilleurs/pire cas et features associées ;
8. statut `collecting|shadow|exploration|confirming|active|rejected` ;
9. si applicable, progression d'un bloc de confirmation (`12/20 nouveaux cas`).

La décision attendue est volontairement humaine : `continuer à observer`, `geler pour
confirmation`, `promouvoir`, `rejeter`, ou `ne rien faire`.

#### Suggestions in-app — conception uniquement, pas de code maintenant

Deux types de suggestions sont autorisés, toutes confinées à l'onglet Prédiction :

**A. Checkpoint temporel** — rappelle qu'un rendez-vous de revue est arrivé **et** qu'il y a
assez de comparaisons pour regarder quelque chose :

```text
🔬 Point d'étape S8 disponible
M3 « heure de la journée » dispose maintenant de 27 cas comparables à M0.
[Voir les résultats] [Plus tard]
```

Si la semaine est atteinte mais que presque aucune comparaison n'existe, la timeline affiche
simplement `en attente de données (n=X)` sans notification.

**B. Signal data-driven** — indépendant d'une semaine précise, lorsqu'un challenger commence
à se détacher :

```text
🧪 Un challenger se détache
M3 améliore la baseline de +7 min en médiane sur 24 cas appariés.
Ce résultat est exploratoire ; aucune modification n'est appliquée.
[Comparer M3 à M0]
```

Puis, si un bloc de confirmation a été déclenché :

```text
🧪 Confirmation en cours
M3 est gelé. 12 / 20 nouveaux cas de confirmation collectés.
Gain provisoire : +6 min.
```

Et seulement après confirmation :

```text
✅ Résultat confirmé
Sur 20 nouveaux cas non utilisés pour sélectionner M3, le gain médian reste +6 min.
Décision à prendre : conserver M0 ou promouvoir M3.
[Voir le dossier de comparaison]
```

Aucune suggestion ne contient un bouton d'activation automatique. Une éventuelle action
`Promouvoir` appartient à une future UI de décision explicite et reste hors périmètre de
codage actuel.

#### Persistance des décisions futures

Lorsqu'un moteur d'expérimentation sera un jour codé, les décisions humaines devront être
tracées séparément des données de sommeil : modèle, version, date, décision, commentaire
optionnel et snapshot de métriques au moment de la décision. **Cette persistance n'est pas
à implémenter maintenant**, mais son existence future est importante pour l'export LLM et
pour éviter de réécrire l'histoire des expérimentations.



### 3.14 Export **LLM-ready** — JSON versionné, auto-descriptif et comparable dans le temps

Objectif : permettre d'exporter régulièrement l'état complet du laboratoire, puis de fournir
un ou plusieurs fichiers à un LLM pour lui demander d'analyser :

- pourquoi Mx diffère de M0 ;
- si le gain est réel ou porté par quelques cas ;
- quand le gain apparaît dans le temps ;
- si le challenger est biaisé ;
- sur quelles tranches/conditions il aide ou dégrade ;
- si une confirmation semble convaincante ;
- quelles expériences méritent d'être poursuivies.

#### Format retenu : **un fichier JSON**, pas CSV

Nom proposé :

```text
sleep-prediction-lab_2026-10-01_1830.json
```

Pourquoi JSON :
- les informations sont hiérarchiques (modèles → métriques → séries temporelles → cas) ;
- plusieurs tables sont liées par `modelId` / `caseId` ;
- les conventions de signe et définitions doivent voyager **dans le fichier** ;
- un CSV obligerait à générer plusieurs fichiers ou à aplatir/perdre du contexte ;
- le volume d'un seul bébé reste suffisamment petit pour exporter l'historique complet.

Le JSON est un **snapshot auto-suffisant**. Il ne dépend pas du fait que le LLM ait lu une
ancienne conversation ou une ancienne version de la spec. Deux exports de dates différentes
peuvent être fournis ensemble pour vérifier que les conclusions évoluent comme attendu.

#### Privacy by default

L'export « analyse LLM » doit être limité au domaine sommeil et **dé-identifié par défaut** :

- pas de nom/prénom ;
- pas de date de naissance exacte ;
- pas d'autres domaines (alimentation, couches, santé...) tant qu'ils ne sont pas eux-mêmes
  utilisés comme features d'un challenger ;
- âge en jours au moment de chaque cas ;
- heure locale nécessaire à M3, mais pas d'adresse/localisation précise ;
- identifiant local neutre (`baby-1`) ;
- `dataStartDate` peut être inclus car il décrit la qualité de la série, pas l'identité.

Si un jour une autre feature sensible est ajoutée, elle doit être explicitement listée dans
`export.featuresIncluded` plutôt que glissée silencieusement dans le fichier.

#### Schéma logique recommandé

```json
{
  "schemaVersion": "sleep-prediction-lab/1.0",
  "generatedAt": "2026-10-01T18:30:00+02:00",
  "export": {
    "purpose": "LLM analysis of champion/challenger sleep prediction models",
    "privacyMode": "sleep-only-deidentified",
    "featuresIncluded": [
      "babyAgeDays",
      "localHour",
      "previousSleepDurationMin",
      "previousWakeDurationMin",
      "elapsedSleepMin"
    ]
  },
  "context": {
    "subjectId": "baby-1",
    "ageDaysAtExport": 56,
    "dataStartDate": "2026-08-11",
    "timezone": "Europe/Paris",
    "championModelId": "M0"
  },
  "conventions": {
    "durationUnit": "minutes",
    "signedError": "actual - predicted; positive means actual happened later",
    "pairedGain": "absError(M0) - absError(Mx); positive means challenger is better",
    "maturityBadge": "depends on n only; it is not prediction quality",
    "walkForward": "each prediction uses only data available before the case"
  },
  "models": [],
  "currentPredictions": [],
  "performance": [],
  "pairwiseComparisonsVsChampion": [],
  "weeklyEvolution": [],
  "checkpoints": [],
  "experiments": [],
  "cases": [],
  "analysisGuide": []
}
```

La structure exacte peut évoluer, d'où `schemaVersion`, mais les catégories sémantiques
ci-dessus doivent rester stables.

#### `models[]` — définir chaque M sans ambiguïté

Chaque entrée contient au minimum :

```json
{
  "id": "M3",
  "label": "Contexte horaire",
  "version": 1,
  "status": "exploration",
  "targets": ["onset", "wake"],
  "features": ["recentHistory", "localHour"],
  "parameters": {
    "windowDays": 14,
    "windowMaxSamples": 40
  },
  "firstComparableAgeDays": 18
}
```

Lorsqu'un modèle est gelé pour confirmation, ses `version` et `parameters` ne changent plus
jusqu'à la fin du bloc ; toute modification crée une nouvelle version expérimentale.

#### `performance[]` — qualité propre de chaque modèle

Par modèle × cible × période (`all`, `recent40`, éventuellement `confirmation`) :

```json
{
  "modelId": "M3",
  "target": "onset",
  "window": "recent40",
  "n": 40,
  "medianAbsErrorMin": 12,
  "p80AbsErrorMin": 21,
  "medianSignedBiasMin": 2
}
```

#### `pairwiseComparisonsVsChampion[]` — la table la plus importante pour le LLM

Toujours sur les **mêmes cas** :

```json
{
  "challengerId": "M3",
  "championId": "M0",
  "target": "onset",
  "pairedN": 40,
  "medianGainMin": 7,
  "p25GainMin": 1,
  "p75GainMin": 13,
  "challengerWins": 28,
  "ties": 2,
  "challengerLosses": 10,
  "recent10MedianGainMin": 9
}
```

#### `weeklyEvolution[]` — permettre au LLM de commenter la maturation

Une ligne par semaine d'âge et par challenger/cible :

```json
{
  "ageWeek": 8,
  "challengerId": "M3",
  "target": "onset",
  "pairedN": 11,
  "championMedianAbsErrorMin": 19,
  "challengerMedianAbsErrorMin": 12,
  "medianGainMin": 7,
  "challengerMedianSignedBiasMin": 2
}
```

Le fichier courant contient **toutes les semaines passées**, pas seulement la semaine de
l'export. Ainsi, un seul export tardif suffit déjà à montrer l'évolution historique.

#### `cases[]` — garder les preuves derrière les agrégats

Une entrée = un cas walk-forward. Les features doivent être celles disponibles **avant** le
résultat réel :

```json
{
  "caseId": "sleep-episode-0102-onset",
  "target": "onset",
  "babyAgeDays": 42,
  "localDateTime": "2026-09-17T16:20:00+02:00",
  "features": {
    "localHour": 16.33,
    "previousSleepDurationMin": 74,
    "previousWakeDurationMin": 61,
    "elapsedSleepMin": null
  },
  "actual": "2026-09-17T17:14:00+02:00",
  "predictions": {
    "M0": {"predicted": "2026-09-17T17:05:00+02:00", "signedErrorMin": 9, "absErrorMin": 9},
    "M3": {"predicted": "2026-09-17T17:13:00+02:00", "signedErrorMin": 1, "absErrorMin": 1}
  }
}
```

Ces lignes sont essentielles : elles permettent au LLM de détecter qu'un gain moyen vient
par exemple exclusivement du soir, d'un type de cas ou de quelques outliers.

#### `checkpoints[]` et `experiments[]`

Inclure l'état tel qu'il était à S4/S6/S8/S10… et les décisions humaines futures :

```json
{
  "checkpoint": "S8",
  "ageDays": 56,
  "date": "2026-10-01",
  "modelSnapshots": {"M0": {}, "M3": {}},
  "humanDecision": null
}
```

```json
{
  "experimentId": "M3-v1-onset",
  "status": "confirming",
  "exploration": {"pairedN": 40, "medianGainMin": 7},
  "confirmation": {"targetN": 20, "currentN": 12, "medianGainMin": 6},
  "decision": null
}
```

#### `analysisGuide[]` — aider un LLM à ne pas mal lire les données

Inclure quelques instructions courtes dans chaque export :

```json
[
  "Compare challengers to M0 only on paired cases.",
  "Do not interpret maturity/recul as accuracy.",
  "Separate exploratory results from non-overlapping confirmation results.",
  "Inspect signed bias as well as absolute error.",
  "Look for drift over age/week and conditional effects in cases.",
  "Prefer a simpler model unless the gain is material and stable.",
  "Do not recommend promotion solely from the latest 10 cases."
]
```

Le but n'est pas de dicter la conclusion au LLM, mais d'éviter les erreurs de lecture les
plus probables.

#### Bouton et comportement d'export — spécification, pas code maintenant

Dans l'onglet Prédiction : bouton **« Exporter pour analyse LLM (.json) »**.

Comportement futur :
1. recalculer le laboratoire au moment du clic ;
2. construire le snapshot complet ;
3. générer le JSON localement côté navigateur (`Blob`) ;
4. télécharger un fichier au nom horodaté ;
5. ne rien envoyer à un serveur externe ;
6. afficher un mini-résumé : `X modèles · Y cas · S1–S8 · schéma v1.0`.

Pas besoin d'un export CSV parallèle en V1. Si un jour une analyse dans Excel devient utile,
un CSV peut être ajouté pour `cases[]`, mais **le JSON reste la source canonique pour un
LLM**.

#### Prompt type à utiliser avec un LLM (documentation seulement)

Le fichier doit être suffisamment auto-descriptif pour ne pas nécessiter ce prompt, mais la
spec peut recommander :

```text
Analyse cet export de laboratoire de prédiction de sommeil.
Compare M0 aux challengers uniquement sur leurs cas appariés. Distingue exploration et
confirmation. Pour chaque M, commente : erreur absolue, biais, gain vs M0, évolution par
semaine, conditions où il gagne/perd, stabilité récente et risque de sur-ajustement.
Termine par : conserver / continuer à observer / confirmer / rejeter, avec les raisons.
Ne traite jamais le badge de recul comme une mesure de précision.
```

**Important :** l'export est une fonctionnalité à spécifier maintenant mais **à ne pas
coder dans la présente étape**, au même titre que le moteur multi-challengers et les
suggestions de checkpoints.

---

## 4. Résumé condensé pour prise de décision

**Le fait central, inchangé** : votre bébé a 7 jours ; le domaine sommeil n'est fiable que
depuis 2 jours. Toute segmentation façon WW1/WW2/WW3 ou ajustement fin reste prématuré, pour
la même raison qu'avant : le phénomène visé n'a pas encore de structure stable à cet âge. Ce
fait justifie toujours de s'attendre à un signal bruyant les premières semaines (§1) — il ne
justifie plus de **cacher** ce signal bruyant : depuis la mise à jour n°3 (§0), on l'affiche
avec un badge de recul honnête plutôt que de le masquer en attendant qu'il mûrisse.

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
| Gating à 4 axes cumulatifs par revendication (âge/jours/échantillons/backtests) avant d'afficher un chiffre | **Retiré** (mise à jour n°3, §0) : badge de recul continu 🌱/🧪/✅ basé sur *n*, affiché À CÔTÉ du chiffre, jamais à sa place — §3.1, §3.6 |
| Calcul lui-même gaté par âge/volume, affichage gaté par la performance mesurée | Le **calcul démarre dès maintenant** ; **l'affichage aussi** — plus aucune étape n'est gatée par l'âge, le volume ou la performance mesurée — §0, §3.5 |
| Plage de réveil masquée si la dispersion de la durée de sommeil est disproportionnée (`SD_MAX_IQR_MEDIAN_RATIO`) | Plage **toujours affichée**, avec une mention « ⚠️ plage large » accolée quand ce seuil est franchi — §3.3 |
| **Un seul prédicteur (écart d'éveil → « prochain réveil »)** | **Deux prédicteurs chaînés** : écart d'éveil → endormissement (§3.2), durée de sommeil → réveil (§3.3) — toute la plage de sommeil, pas seulement le réveil |
| **Estimation affichée en durée seule** (« ≈ 67 min d'éveil ») | **Convertie en heure d'horloge** (« endormissement estimé vers 08:27 ») — §3.9 |
| Un seul backtest, une seule mesure de qualité | **Deux backtests indépendants** (un par prédicteur) + une **3e mesure diagnostique** (round-trip chaîné), jamais un gate ; les résidus **signés** calibrent la plage quand bébé est éveillé — §3.4-3.6 |
| *(non traité)* | **Gestion d’état explicite** : `AWAKE` chaîne onset+durée ; `ASLEEP` repart immédiatement de l’endormissement réel — §3.4 |
| *(non traité)* | **Laboratoire Champion / Challengers** : M1–Mx calculés en shadow dès qu’ils sont calculables ; S4/S6/S8/S10 deviennent des checkpoints de lecture et de décision humaine — §3.8, §3.12-§3.13 |
| *(non traité)* | **Export LLM JSON versionné** : définitions des M, métriques appariées, évolution hebdomadaire, checkpoints et cas individuels dans un snapshot auto-descriptif — §3.14 |
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

**Socle V1 à implémenter lorsque le codage sera demandé** :
- Écrire dans `stats.js` les deux prédicteurs (fenêtre glissante, médiane/P25/P75) : un pour
  l'écart d'éveil (§3.2), un pour la durée de sommeil (§3.3) — même contrat que
  `Stats.compute`, réutilisant `_resolveSleep`.
- Démarrer les **deux backtests silencieux** (§3.5) dès aujourd'hui — le domaine sommeil
  est fiable depuis le 11 août, donc il n'y a aucune raison d'attendre pour commencer à
  logger (erreur, date, âge) à chaque nouvel épisode, pour les deux prédicteurs.
- Construire le **4e onglet « Prédiction »** (§3.8) — visible dès qu'il y a ≥ 1 point de
  donnée sur au moins un des deux prédicteurs, clairement étiqueté expérimental, chaque
  chiffre accompagné de son badge de recul 🌱/🧪/✅ ; recalcul à l'ouverture d'onglet, pas de timer
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
forme de retour V1 peut conserver les champs baseline décrits dans la mise à jour n°4
(`onset`, `duration`, `quality1`, `quality2`, `roundtrip`, tables et état AWAKE/ASLEEP).
Lorsque le laboratoire multi-modèles sera implémenté, ce contrat devra être **étendu**, pas
remplacé, par `models[]`, `currentPredictions[]`, `performance[]`,
`pairwiseComparisonsVsChampion[]`, `weeklyEvolution[]`, `checkpoints[]`, `experiments[]` et
`cases[]`, avec les mêmes définitions que l'export canonique du §3.14. Ainsi UI et export
consomment la même vérité calculée au lieu de reconstruire deux analyses différentes. `renderPrediction()` dans `app.js` peut réutiliser quasi tel quel les fonctions
de rendu du mockup (`renderContext`, `renderOnsetBlock`, `renderWakeBlock`,
`renderQualityInto`, `renderTable`, `tierBadge`) : elles sont déjà la référence de comment
chaque champ doit être consommé et affiché — les copier/adapter plutôt que réinventer un
rendu différent depuis la description en prose du §3.8-3.9.

**Ce qu'on n'affiche jamais ailleurs que dans l'onglet Prédiction, indépendamment de tout
seuil d'âge ou de volume** (§3.8) : toute tendance de sommeil dans l'onglet Suivi, toute
notification système/push. La seule exception future est la suggestion **in-app** de test
décrite en §3.13, confinée à l'onglet Prédiction et explicitement hors périmètre de codage
actuel. Ce n'est plus une question de maturité mais de canal — le bandeau factuel
existant dans le Suivi (« ⏱ Xmin » / « il y a Xh ») reste inchangé ; seul l'onglet
Prédiction montre des estimations, sans condition d'âge ou de volume pour y accéder, avec
son propre avertissement permanent rappelant leur caractère expérimental.

**Décisions de conception consolidées — spec prête pour une future implémentation, mais aucun code demandé à ce stade**
(historique des questions qui étaient encore ouvertes avant la mise à jour n°3, et comment
elles ont été tranchées) :
1. ~~Seuil d'âge de 56 jours pour déclencher l'affichage hors onglet Prédiction~~ —
   **RÉSOLU (§0, §1, §3.1) : retiré.** Aucun seuil d'âge ne déclenche ni ne bloque plus
   aucun affichage ; l'âge reste affiché comme contexte informatif seulement.
2. Les seuils numériques du document (fenêtres 14j/40 échantillons, paliers de recul
   20/40 backtests) sont les valeurs par défaut à implémenter telles que documentées en
   §3.2/§3.3/§3.5 — ce ne sont plus des conditions d'affichage mais des tailles de fenêtre
   et des bornes de badge, ajustables plus tard si le backtest lui-même (une fois en place)
   suggère qu'elles sont mal calibrées pour ce bébé.
3. Le contenu cible de l’onglet Prédiction est désormais celui du **laboratoire Champion /
   Challengers** du §3.8 : Maintenant, performance comparée, évolution temporelle, checkpoints,
   cas par cas, expériences et export LLM. Le rendu AWAKE/ASLEEP de la baseline (§3.4/§3.9)
   reste inclus à l’intérieur de cette vue. **La spec écrite est normative** ; le mockup HTML
   antérieur doit être refait avant de redevenir une référence visuelle.
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
7. Ce document constitue **la spec de référence, pas une demande de codage dans ce tour**.
   Lorsqu’une implémentation sera demandée, l’ordre logique recommandé est : socle baseline et
   backtests (§3.2-§3.6), puis laboratoire Champion / Challengers (§3.8, §3.10, §3.12), puis
   checkpoints/suggestions (§3.13) et export LLM (§3.14).
8. **Round-trip corrigé** : conserver les résidus signés pour la calibration de la plage et
   les valeurs absolues uniquement pour les métriques de performance (§3.4-§3.5).
9. **Gestion d'état corrigée** : dès que bébé dort réellement, le réveil est calculé depuis
   `actualSleepStart`, jamais depuis l'endormissement précédemment prédit (§3.4).
10. **Laboratoire / checkpoints / export** : les §3.8, §3.10, §3.12-§3.14 définissent la
    cible Champion / Challengers, les checkpoints, les suggestions in-app et l’export JSON
    LLM-ready. **Ils sont spécifiés mais ne sont pas à coder dans la présente étape.** Lorsqu’une
    implémentation sera demandée, M1–Mx devront commencer en shadow dès qu’ils sont calculables ;
    aucune semaine et aucun score ne déclenchera une promotion automatique.
