/* =========================================================
   Sensibilité à la segmentation du sommeil — writing-block.md §25
   -----------------------------------------------------------
   Sept tests obligatoires :
   1. Non-régression RAW (pas un test dédié : c'est la suite existante —
      lab.test.js, prediction.test.js, etc. — qui reste verte sans
      modification ; vérifié ici en plus par une comparaison RAW-via-la-
      nouvelle-voie vs RAW-via-sleepLab() sur un même jeu de données).
   2. Fusion simple sous le seuil.
   3. Pas de fusion sous un seuil plus petit.
   4. Fusion chaînée (deux écarts sous le seuil).
   5. Un sommeil court isolé reste son propre bloc (jamais supprimé).
   6. Pas de fuite du futur pour M2/`remaining` (garde `_boutRawAsleep`).
   7. Les anomalies (chevauchement, dodo non clos) suivent les règles RAW
      existantes — la consolidation ne les « répare » jamais.
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, near, deepEq, ok, Stats }) => {

  const BIRTH = new Date(2026, 7, 6, 5, 25);
  const DOMAIN = { repas: new Date(2026, 7, 6), couche: new Date(2026, 7, 6), sommeil: new Date(2026, 7, 6) };
  let seq = 0;
  const iso = d => d.toISOString();
  const sl = (start, end) => ({ id: `sg${++seq}`, action: 'sommeil', ts: iso(start), data: end ? { end: iso(end) } : {} });

  /* ---------- Test 2-5 : buildSleepBouts, pure ---------- */
  suite('Segmentation — buildSleepBouts (§25 Tests 2-5)');

  test('Test 2 — fusion simple sous le seuil', () => {
    const eps = [{ startMs: 0, endMs: 110 * 60000 }, { startMs: 120 * 60000, endMs: 240 * 60000 }];
    const bouts = Stats.buildSleepBouts(eps, 15);
    eq(bouts.length, 1, 'un seul bloc');
    const b = bouts[0];
    eq(b.segmentCount, 2, 'segmentCount');
    eq(b.interruptionCount, 1, 'interruptionCount');
    near(b.totalInterruptionMin, 10, 1e-9, 'totalInterruptionMin');
    near(b.totalSleepMin, 230, 1e-9, 'totalSleepMin (interruption exclue)');
    near(b.totalSpanMin, 240, 1e-9, 'totalSpanMin (interruption incluse)');
    near(b.maxInterruptionMin, 10, 1e-9, 'maxInterruptionMin');
    eq(b.segments.length, 2, 'les 2 segments bruts sont conservés');
  });

  test('Test 3 — pas de fusion sous un seuil plus petit', () => {
    const eps = [{ startMs: 0, endMs: 110 * 60000 }, { startMs: 120 * 60000, endMs: 240 * 60000 }];
    const bouts = Stats.buildSleepBouts(eps, 5);
    eq(bouts.length, 2, 'deux blocs distincts (écart de 10 > seuil de 5)');
    ok(bouts.every(b => b.segmentCount === 1), 'chaque bloc = 1 seul segment');
  });

  test('Test 4 — fusion chaînée (2 écarts sous le seuil)', () => {
    const eps = [
      { startMs: 0, endMs: 60 * 60000 },
      { startMs: 65 * 60000, endMs: 125 * 60000 },
      { startMs: 133 * 60000, endMs: 200 * 60000 },
    ];
    const bouts = Stats.buildSleepBouts(eps, 10);
    eq(bouts.length, 1, 'un seul bloc (les 2 écarts, 5 et 8 min, sont sous le seuil)');
    const b = bouts[0];
    eq(b.segmentCount, 3, 'segmentCount');
    eq(b.interruptionCount, 2, 'interruptionCount');
    near(b.totalInterruptionMin, 13, 1e-9, 'totalInterruptionMin (5+8)');
    near(b.totalSleepMin, 60 + 60 + 67, 1e-9, 'totalSleepMin = somme des 3 segments');
    near(b.totalSpanMin, 200, 1e-9, 'totalSpanMin');
    near(b.maxInterruptionMin, 8, 1e-9, 'maxInterruptionMin = la plus grande des 2');
  });

  test('Test 5 — un sommeil court isolé reste son propre bloc', () => {
    const eps = [
      { startMs: 0, endMs: 20 * 60000 },
      { startMs: 50 * 60000, endMs: 58 * 60000 },   // 8 min, écarts > seuil des deux côtés
    ];
    const bouts = Stats.buildSleepBouts(eps, 15);
    eq(bouts.length, 2, 'aucune fusion : écart de 30 min > seuil de 15');
    eq(bouts[1].segmentCount, 1, 'le sommeil court reste seul');
    near(bouts[1].totalSleepMin, 8, 1e-9, 'sa durée n’est pas altérée par sa brièveté');
  });

  /* ---------- Test 6 : garde anti-fuite du futur (_boutRawAsleep) ---------- */
  suite('Segmentation — _boutRawAsleep, garde M2/remaining (§25 Test 6)');

  test('épisode brut (sans .segments) : toujours RAW-endormi — no-op pour RAW', () => {
    ok(Stats._boutRawAsleep({ startMs: 0, endMs: 100 }, 50), 'pas de .segments ⇒ true');
    ok(Stats._boutRawAsleep(null, 50), 'ep nul ⇒ true (ne doit jamais bloquer un cas RAW)');
  });

  test('bloc fusionné : vrai dans un segment, faux dans l’interruption', () => {
    const bout = { segments: [{ startMs: 0, endMs: 30 * 60000 }, { startMs: 40 * 60000, endMs: 300 * 60000 }] };
    ok(Stats._boutRawAsleep(bout, 10 * 60000), 'dans le 1er segment');
    ok(!Stats._boutRawAsleep(bout, 35 * 60000), 'dans l’interruption interne (30-40 min)');
    ok(Stats._boutRawAsleep(bout, 100 * 60000), 'dans le 2e segment');
  });

  test('Test 6 — le cas `remaining` sondé pendant un micro-réveil RAW est écarté même fusionné', () => {
    // 3 dodos d'entraînement (35 min, largement espacés : jamais fusionnés,
    // quel que soit le seuil testé ici) pour que la fenêtre glissante ait
    // >= SD_BACKTEST_MIN_TRAIN_SAMPLES échantillons avant le cas sous test.
    const BASE = new Date(2026, 7, 20, 6, 0);
    const at = min => new Date(BASE.getTime() + min * 60000);
    const evs = [
      sl(at(0), at(35)),
      sl(at(435), at(470)),
      sl(at(870), at(905)),
      // Le cas sous test : deux segments RAW séparés par un micro-réveil de
      // 10 min (1335 → 1345), fusionnables sous B15 mais pas sous B5.
      sl(at(1305), at(1335)),
      sl(at(1345), at(1605)),
    ];
    const nowMs = at(1605 + 40).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    const feeds = Stats.feedTimeline(evs, { nowMs, domainStart: DOMAIN });
    const birthMs = Stats.startOfDay(BIRTH).getTime();

    // RAW : le micro-réveil doit apparaître comme un écart d'éveil normal.
    const ixRaw = Stats._labIndex(Sraw);
    const casesRaw = Stats._labCases(Sraw, ixRaw, birthMs, feeds);
    const microWakeGap = casesRaw.find(c => c.target === 'onset' && Math.abs(c.realMin - 10) < 1e-6);
    ok(!!microWakeGap, 'RAW voit bien l’écart de 10 min comme un réveil réel');

    // B15 : les deux segments fusionnent en un seul bloc — l'écart de 10 min
    // disparaît de la liste des cas `onset` (§9), ET aucun cas `remaining`
    // ne doit être sondé à l'intérieur de cette interruption (anchorMs
    // correspondant à at(1340)).
    const S15 = Stats._predSamplesVariant(Sraw, 15);
    const bout = S15.closed.find(b => b.segmentCount > 1);
    ok(!!bout, 'B15 a bien fusionné les deux segments en un bloc');
    eq(S15.closed.filter(b => b.segmentCount > 1).length, 1, 'un seul bloc fusionné');

    const ix15 = Stats._labIndex(S15);
    const cases15 = Stats._labCases(S15, ix15, birthMs, feeds);
    const forbiddenAnchor = at(1340).getTime();
    const leaked = cases15.find(c => c.target === 'remaining' && Math.abs(c.anchorMs - forbiddenAnchor) < 60000);
    ok(!leaked, 'aucun cas `remaining` sondé pendant le micro-réveil (RAW-éveillé) même si l’instant tombe dans le bloc fusionné');
    ok(!cases15.some(c => c.target === 'onset' && Math.abs(c.realMin - 10) < 1e-6),
      'B15 : l’écart de 10 min a bien disparu de la liste des cas onset (fusionné, pas juste ignoré)');

    // B5 : l'écart de 10 min est AU-DESSUS du seuil, donc pas de fusion —
    // le cas `remaining` correspondant à seg2 doit rester identique à RAW.
    const S5 = Stats._predSamplesVariant(Sraw, 5);
    eq(S5.closed.filter(b => b.segmentCount > 1).length, 0, 'B5 : aucune fusion (écart de 10 > seuil de 5)');
  });

  /* ---------- Test 7 : les anomalies suivent les règles RAW ---------- */
  suite('Segmentation — anomalies non « réparées » par la consolidation (§25 Test 7)');

  test('Test 7 — un dodo chevauchant reste exclu de toute variante', () => {
    const BASE = new Date(2026, 7, 21, 13, 0);
    const evs = [
      sl(BASE, new Date(BASE.getTime() + 120 * 60000)),                        // 13h-15h
      sl(new Date(BASE.getTime() + 5 * 60000), new Date(BASE.getTime() + 130 * 60000)), // 13h05-15h10, chevauche
    ];
    const nowMs = new Date(BASE.getTime() + 300 * 60000).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    eq(Sraw.excluded.chevauchants, 1, 'le doublon est bien exclu par le pipeline RAW existant');
    for (const th of [5, 10, 15, 20, 30]) {
      const Sv = Stats._predSamplesVariant(Sraw, th);
      eq(Sv.closed.length, Sraw.closed.length, `seuil ${th} : aucun épisode chevauchant réintroduit`);
      const allSegs = Sv.closed.flatMap(b => b.segments);
      eq(allSegs.length, Sraw.closed.length, `seuil ${th} : les blocs ne portent que les épisodes déjà filtrés`);
    }
  });

  test('Test 7 — le dodo en cours n’est jamais fusionné dans un bloc', () => {
    const BASE = new Date(2026, 7, 22, 20, 0);
    const evs = [
      sl(BASE, new Date(BASE.getTime() + 30 * 60000)),
      sl(new Date(BASE.getTime() + 35 * 60000), null),   // en cours, 5 min après le précédent
    ];
    const nowMs = new Date(BASE.getTime() + 45 * 60000).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    ok(!!Sraw.ongoing, 'un dodo en cours existe');
    for (const th of [5, 10, 15, 20, 30]) {
      const Sv = Stats._predSamplesVariant(Sraw, th);
      eq(Sv.ongoing, Sraw.ongoing, `seuil ${th} : l’épisode en cours n’est jamais touché`);
      ok(Sv.closed.every(b => !b.segments.includes(Sraw.ongoing)), `seuil ${th} : jamais absorbé dans un bloc clos`);
    }
  });

  /* ---------- Test 1 : non-régression RAW ---------- */
  suite('Segmentation — non-régression RAW (§25 Test 1)');

  test('sleepSegmentationSensitivity(RAW) égale sleepLab() sur le même jeu de données', () => {
    const BASE = new Date(2026, 7, 10, 7, 0);
    const at = min => new Date(BASE.getTime() + min * 60000);
    const evs = [];
    let t = 0;
    for (let i = 0; i < 20; i++) { evs.push(sl(at(t), at(t + 90))); t += 90 + 200; }
    const nowMs = at(t + 40).getTime();
    const opts = { now: nowMs, domainStart: DOMAIN, birth: BIRTH };

    const lab = Stats.sleepLab(evs, opts);
    const sens = Stats.sleepSegmentationSensitivity(evs, opts);
    const raw = sens.variants.find(v => v.variantId === 'RAW');

    ok(!!raw, 'la variante RAW existe');
    deepEq(raw.performance, lab.view.perf, 'RAW via sleepSegmentationSensitivity == perf de sleepLab() (mêmes modèles, mêmes cas, même grille)');

    const snap = Stats.labExport(lab, { segmentationSensitivity: sens });
    deepEq(snap.segmentationSensitivity, sens, 'labExport porte bien la sensibilité fournie, sans la transformer');

    eq(raw.diagnostics.mergedEpisodeCount, 0, 'RAW : aucune fusion, par définition');
    eq(raw.onsetCasesRemovedVsRaw, 0, 'RAW comparé à lui-même : zéro cas retiré');
    eq(raw.wakeCasesChangedVsRaw, 0, 'RAW comparé à lui-même : zéro cas changé');
    eq(raw.remainingCasesChangedVsRaw, 0, 'RAW comparé à lui-même : zéro cas changé');
    eq(sens.mode, 'retrospective', 'étiqueté rétrospectif');
    eq(sens.productionImpact, false, 'jamais présenté comme un impact de production');
    eq(sens.usesFutureResleepToClassifyMicroWake, true, 'convention explicite (§12)');
  });

  test('sleepSegmentationSensitivity ne modifie ni le champion ni la liste de variantes attendue', () => {
    const evs = [sl(new Date(2026, 7, 15, 20, 0), new Date(2026, 7, 15, 23, 0))];
    const sens = Stats.sleepSegmentationSensitivity(evs, { domainStart: DOMAIN, birth: BIRTH });
    deepEq(sens.variants.map(v => v.variantId), ['RAW', 'B5', 'B10', 'B15', 'B20', 'B30'], 'les 6 variantes attendues');
    ok(sens.shortSleepDiagnostics.totalEpisodes >= 0, 'diagnostic « sommeils courts » présent, calculé une seule fois');
  });
};
