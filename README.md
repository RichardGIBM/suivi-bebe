# Suivi Bébé

Application web mobile de suivi quotidien de bébé : tétées, biberons, couches, sommeil,
soins (yeux, nez, cordon), vitamine D, température, médicaments et « ce que bébé a appris ».

- **100 % statique** (HTML/CSS/JS, sans build) — hébergé sur GitHub Pages.
- **PWA** : installable sur l'écran d'accueil, fonctionne hors-ligne.
- Données stockées localement (`localStorage`) via une couche `Store` isolée
  (prévue pour être remplacée par une synchro temps réel ultérieurement).

## Lancer en local

```bash
python3 -m http.server 4321
```

Puis ouvrir http://localhost:4321

## Icônes

Les icônes PWA sont générées par `tools/gen_icons.py` (cœur blanc sur dégradé rose→bleu).
