'use strict';
/* =========================================================
   Cascade multi-champions — M6 (réveil initial) / M2 vs M2v2 (réestimation)
   -----------------------------------------------------------
   Spec : writing-block « Promotion M6 / M2 et expérimentation parallèle M2v2 ».
   Onze tests obligatoires (§41-43), répartis ci-dessous :
     1. AWAKE                         → Test 1
     2. M6 applicable                 → Test 2
     3. M6 inapplicable → repli M0    → Test 3
     4. aucun trigger atteint         → Test 4
     5. M2 seul déclenché             → Test 5
     6. M2v2 seul déclenché           → Test 6
     7. M2 + M2v2 déclenchés          → Test 7
     8. réveil entre les triggers     → Test 8a / 8b (+ 8c anti-fuite, fusion RAW)
     9. M2 périmé (heure passée)      → Test 9
    10. comparaison appariée M2v2/M2  → Test 10
    11. réveil réel invalide tout     → Test 11

   Fixtures :
   - earlyEvents()      : M6 se déclenche AVANT le sentinel M0 (jour=20min×5 homogène,
                           nuit=[80,90,100,110,120]). m0Sentinel=+50, M6=+20.
   - lateSpreadEvents() : sentinel M0 puis M6 puis M2 puis M2v2, quatre paliers distincts
                           (valeurs asymétriques et chevauchantes, jamais un pur split
                           bimodal — sinon M2 et M6 coïncident numériquement et le test 7
                           ne peut plus distinguer les deux modèles).
                           nuit=[5,6,7,8,500], jour=[50,60,300,310,320].
                           m0Sentinel=+55, M6=+300, M2=+310, M2v2=+320.
   ========================================================= */
module.exports = ({ suite, test, eq, near, ok, Stats }) => {
  const BIRTH = new Date(2026, 6, 1, 5, 25);
  const DOMAIN = { repas: new Date(2026, 6, 1), couche: new Date(2026, 6, 1), sommeil: new Date(2026, 6, 1) };
  let seq = 0;
  const iso = d => d.toISOString();
  const sl = (start, end) => ({ id: `mc${++seq}`, action: 'sommeil', ts: iso(start), data: end ? { end: iso(end) } : {} });
  const add = (d, min) => new Date(d.getTime() + min * 60000);
  const birthMs = () => Stats.startOfDay(BIRTH).getTime();

  function earlyEvents() {
    const nightVals = [80, 90, 100, 110, 120];
    const dayVals = [20, 20, 20, 20, 20];
    const evs = [];
    for (let k = 1; k <= 5; k++) {
      const n0 = new Date(2026, 7, k, 2, 0);
      evs.push(sl(n0, add(n0, nightVals[k - 1])));
      const d0 = new Date(2026, 7, k, 13, 0);
      evs.push(sl(d0, add(d0, dayVals[k - 1])));
    }
    return evs;
  }
  const START_EARLY = new Date(2026, 7, 10, 13, 0);

  function lateSpreadEvents() {
    const nightVals = [5, 6, 7, 8, 500];
    const dayVals = [50, 60, 300, 310, 320];
    const evs = [];
    for (let k = 1; k <= 5; k++) {
      const n0 = new Date(2026, 7, k, 2, 0);
      evs.push(sl(n0, add(n0, nightVals[k - 1])));
      const d0 = new Date(2026, 7, k, 13, 0);
      evs.push(sl(d0, add(d0, dayVals[k - 1])));
    }
    return evs;
  }
  const START_LATE = new Date(2026, 7, 10, 13, 0);

  function smallHistoryEvents() {
    const evs = [];
    for (let k = 1; k <= 3; k++) {
      const d0 = new Date(2026, 7, k, 13, 0);
      evs.push(sl(d0, add(d0, 45)));
    }
    return evs;
  }

  suite('Cascade M6/M2/M2v2 — sleepPrediction() : état et déclenchements (§41-42)');

  test('Test 1 — AWAKE : aucune cascade', () => {
    const evs = [sl(new Date(2026, 7, 9, 20, 0), new Date(2026, 7, 9, 23, 0))];
    const now = new Date(2026, 7, 9, 23, 30);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.state, 'AWAKE', 'état');
    eq(p.wakeCascade, null, 'aucune cascade en AWAKE');
  });

  test('Test 2 — ASLEEP, M6 applicable : réveil initial = M6', () => {
    const evs = earlyEvents();
    evs.push(sl(START_EARLY, null));
    const now = add(START_EARLY, 5);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.state, 'ASLEEP');
    ok(!!p.wakeCascade, 'cascade présente');
    eq(p.wakeCascade.initialWake.modelId, 'M6', 'initialWake = M6');
    eq(p.wake.basis, 'm6');
    eq(p.wake.modelId, 'M6');
    near(p.wake.atMs, add(START_EARLY, 20).getTime(), 1, 'M6 = médiane jour (20 min)');
  });

  test('Test 3 — M6 non applicable (< 5 échantillons/heure) : repli M0', () => {
    const evs = smallHistoryEvents();
    const start = new Date(2026, 7, 10, 13, 0);
    evs.push(sl(start, null));
    const now = add(start, 5);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.wakeCascade.initialWake.modelId, 'M0');
    eq(p.wakeCascade.initialWake.isFallback, true);
    eq(p.wakeCascade.initialWake.fallbackFor, 'M6');
    eq(p.wake.basis, 'm0-fallback');
    eq(p.wake.isFallback, true);
    eq(p.wake.fallbackFor, 'M6');
    near(p.wake.atMs, add(start, 45).getTime(), 1);
    near(p.wake.loMs, add(start, 45).getTime(), 1);
    near(p.wake.hiMs, add(start, 45).getTime(), 1);
  });

  test('Test 4 — aucun trigger atteint : M2 et M2v2 absents, effectif = M6', () => {
    const evs = earlyEvents();
    evs.push(sl(START_EARLY, null));
    const now = add(START_EARLY, 10);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.wakeCascade.m2, null, 'M2 absent');
    eq(p.wakeCascade.m2v2, null, 'M2v2 absent');
    eq(p.wakeCascade.effectiveModelId, 'M6');
    eq(p.wake.basis, 'm6');
  });

  test('Test 5 — M2 seul (sentinel M0 dépassé, M6 pas encore) : effectif = M2', () => {
    const evs = lateSpreadEvents();
    evs.push(sl(START_LATE, null));
    const now = add(START_LATE, 100);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    ok(!!p.wakeCascade.m2, 'M2 présent');
    eq(p.wakeCascade.m2v2, null, 'M2v2 absent');
    eq(p.wakeCascade.effectiveModelId, 'M2');
    eq(p.wake.basis, 'm2');
    near(p.wake.atMs, add(START_LATE, 310).getTime(), 1);
  });

  test('Test 6 — M2v2 seul (M6 dépassé, sentinel M0 pas encore) : effectif reste M6', () => {
    const evs = earlyEvents();
    evs.push(sl(START_EARLY, null));
    const now = add(START_EARLY, 35);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.wakeCascade.m2, null, 'M2 absent (sentinel pas dépassé)');
    ok(!!p.wakeCascade.m2v2, 'M2v2 présent');
    eq(p.wakeCascade.effectiveModelId, 'M6', 'M2v2 ne devient jamais la prédiction affichée');
    eq(p.wake.basis, 'm6');
    near(p.wake.atMs, add(START_EARLY, 20).getTime(), 1, 'wake reste la valeur M6, pas M2v2');
  });

  test('Test 7 — M2 et M2v2 tous deux déclenchés : M2v2 visible seulement en cascade', () => {
    const evs = lateSpreadEvents();
    evs.push(sl(START_LATE, null));
    const now = add(START_LATE, 305);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    ok(!!p.wakeCascade.m2, 'M2 présent');
    ok(!!p.wakeCascade.m2v2, 'M2v2 présent');
    eq(p.wakeCascade.effectiveModelId, 'M2');
    near(p.wake.atMs, add(START_LATE, 310).getTime(), 1, 'wake = M2');
    near(p.wakeCascade.m2v2.atMs, add(START_LATE, 320).getTime(), 1, 'M2v2 a sa propre valeur, distincte, jamais utilisée pour wake');
  });

  test('Test 9 — M2 périmé (heure déjà passée) : jamais utilisé comme wake effectif', () => {
    const evs = lateSpreadEvents();
    evs.push(sl(START_LATE, null));
    const now = add(START_LATE, 315);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.wakeCascade.m2.valid, false, 'M2 marqué invalide (déjà passé)');
    eq(p.wakeCascade.effectiveModelId, 'M6', 'repli sur initialWake (M6)');
    near(p.wake.atMs, add(START_LATE, 300).getTime(), 1, 'valeur M6, pas la valeur périmée de M2 (310)');
    eq(p.wake.beyondRange, true);
  });

  test('Test 11 — réveil réel : la cascade est invalidée, retour à AWAKE/onset', () => {
    const evs = earlyEvents();
    const end = add(START_EARLY, 30);
    evs.push(sl(START_EARLY, end));
    const now = add(end, 5);
    const p = Stats.sleepPrediction(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    eq(p.state, 'AWAKE');
    eq(p.wakeCascade, null, 'M6/sentinel/M2/M2v2 tous invalidés');
    eq(p.sinceMs, end.getTime());
  });

  suite('Cascade M6/M2/M2v2 — cas de laboratoire remaining/remainingV2 (§28, Test 8)');

  test('Test 8a — réveil réel entre sentinel M0 et déclenchement M6 : seul `remaining` existe', () => {
    const evs = lateSpreadEvents();
    const start = START_LATE;
    const realEnd = add(start, 100);
    evs.push(sl(start, realEnd));
    const nowMs = add(realEnd, 5).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    const feeds = Stats.feedTimeline(evs, { nowMs, domainStart: DOMAIN });
    const ix = Stats._labIndex(Sraw);
    const cases = Stats._labCases(Sraw, ix, birthMs(), feeds);
    const remaining = cases.find(c => c.target === 'remaining' && c.realMs === realEnd.getTime());
    const remainingV2 = cases.find(c => c.target === 'remainingV2' && c.realMs === realEnd.getTime());
    ok(!!remaining, 'le cas `remaining` (M0 dépassé) est créé');
    ok(!remainingV2, 'aucun cas `remainingV2` artificiel (M6 pas encore dépassé à ce moment-là)');
  });

  test('Test 8b — réveil réel entre déclenchement M6 et sentinel M0 : seul `remainingV2` existe', () => {
    const evs = earlyEvents();
    const start = START_EARLY;
    const realEnd = add(start, 35);
    evs.push(sl(start, realEnd));
    const nowMs = add(realEnd, 5).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    const feeds = Stats.feedTimeline(evs, { nowMs, domainStart: DOMAIN });
    const ix = Stats._labIndex(Sraw);
    const cases = Stats._labCases(Sraw, ix, birthMs(), feeds);
    const remaining = cases.find(c => c.target === 'remaining' && c.realMs === realEnd.getTime());
    const remainingV2 = cases.find(c => c.target === 'remainingV2' && c.realMs === realEnd.getTime());
    ok(!remaining, 'aucun cas `remaining` artificiel (sentinel M0 pas encore dépassé)');
    ok(!!remainingV2, 'le cas `remainingV2` (M6 dépassé) est créé');
  });

  test('Test 8c — anti-fuite : un micro-réveil RAW fusionné n’engendre aucun cas `remainingV2` artificiel', () => {
    const evs = [];
    for (let k = 1; k <= 5; k++) {
      const d0 = new Date(2026, 7, k, 13, 0);
      evs.push(sl(d0, add(d0, 35)));
    }
    const boutStart = new Date(2026, 7, 10, 13, 0);
    const seg1End = add(boutStart, 30);
    const seg2Start = add(boutStart, 40);
    const seg2End = add(boutStart, 300);
    evs.push(sl(boutStart, seg1End));
    evs.push(sl(seg2Start, seg2End));
    const nowMs = add(seg2End, 30).getTime();
    const Sraw = Stats._predSamples(evs, { nowMs, domainStart: DOMAIN });
    const feeds = Stats.feedTimeline(evs, { nowMs, domainStart: DOMAIN });
    const bMs = birthMs();

    const S15 = Stats._predSamplesVariant(Sraw, 15);
    const fused = S15.closed.find(b => b.segmentCount > 1);
    ok(!!fused, 'le bloc fusionné existe (écart de 10 min < seuil 15)');
    const ix15 = Stats._labIndex(S15);
    const cases15 = Stats._labCases(S15, ix15, bMs, feeds);
    const m6ProbeMs = add(boutStart, 35).getTime();
    const leaked = cases15.find(c => c.target === 'remainingV2' && Math.abs(c.anchorMs - m6ProbeMs) < 60000);
    ok(!leaked, 'aucun cas `remainingV2` sondé pendant le micro-réveil RAW, même une fois le bloc fusionné');

    const S5 = Stats._predSamplesVariant(Sraw, 5);
    eq(S5.closed.filter(b => b.segmentCount > 1).length, 0, 'B5 : aucune fusion (écart de 10 > seuil de 5)');
    const ix5 = Stats._labIndex(S5);
    const cases5 = Stats._labCases(S5, ix5, bMs, feeds);
    const seg2ProbeMs = add(boutStart, 75).getTime();
    const present = cases5.find(c => c.target === 'remainingV2' && Math.abs(c.anchorMs - seg2ProbeMs) < 60000);
    ok(!!present, 'B5 (pas de fusion) : le cas `remainingV2` du 2e segment existe normalement — la garde ne bloque pas tout');
  });

  suite('Cascade M6/M2/M2v2 — comparaison appariée M2v2 vs M2 (§30, Test 10)');

  test('Test 10 — _labPairedM2v2VsM2 apparie remaining/remainingV2 sur le même réveil réel', () => {
    const evs = lateSpreadEvents();
    const start = START_LATE;
    const realEnd = add(start, 400);
    evs.push(sl(start, realEnd));
    const now = add(realEnd, 30);
    const lab = Stats.sleepLab(evs, { now, domainStart: DOMAIN, birth: BIRTH });
    const paired = Stats._labPairedM2v2VsM2(lab);
    eq(paired.pairedN, 1, 'une seule paire (même réveil réel, M2 et M2v2 ont chacun prédit)');
    near(paired.medianGainMin, 10, 1e-6, 'gain = |erreur M2|(90) − |erreur M2v2|(80)');
    eq(paired.M2v2Wins, 1);
    eq(paired.ties, 0);
    eq(paired.M2v2Losses, 0);
    near(paired.recent10MedianGainMin, 10, 1e-6);
  });

  suite('Cascade M6/M2/M2v2 — champions par cible dans le laboratoire (v38)');

  /* Cas fabriqués pour la vue du labo : `errs` = erreur signée voulue, par
     modèle (même fabrique que tests/lab.test.js — copie locale, les fichiers
     de test n'ont pas de fixtures partagées). */
  const fakeLabCases = (target, n, errs) => Array.from({ length: n }, (_, i) => {
    const preds = {};
    for (const id of Object.keys(errs)) {
      preds[id] = { predMin: id === 'M0' ? 0 : 1, predMs: 0, signedErrMin: errs[id], absErrMin: Math.abs(errs[id]) };
    }
    return {
      id: `${target}-${String(i + 1).padStart(4, '0')}`, target,
      asOfMs: i, anchorMs: 0, realMs: (i + 1) * 3600000, realMin: 0,
      ageDays: Math.floor(i / 6), features: {}, preds,
    };
  });

  test('M6 devient `active` sur `wake` une fois déclenché, mais reste un challenger ordinaire sur `onset`', () => {
    // M6 a des cas des DEUX cibles (§21/§33/§34 : M6 est champion de `wake`,
    // mais un challenger comme un autre sur `onset`, où M0 reste champion) —
    // le statut ne doit dépendre QUE de la cible, jamais du modèle seul.
    const cs = fakeLabCases('wake', 40, { M0: 30, M6: 5 }).concat(fakeLabCases('onset', 40, { M0: 30, M6: 5 }));
    const V = Stats._labView(cs, Infinity);
    eq(V.byTarget.M6.wake.status, 'active', 'M6/wake : champion de production');
    ok(/production/.test(V.byTarget.M6.wake.why), 'raison : champion en production');
    ok(V.byTarget.M6.onset.status !== 'active', 'M6/onset : challenger ordinaire, jamais actif');
    eq(V.byTarget.M0.wake.status, 'active', 'M0/wake : reste actif (référence historique de comparaison)');
    ok(!/production/.test(V.byTarget.M0.wake.why), 'M0/wake : la raison ne prétend plus être ce qui est affiché');
    eq(V.byTarget.M0.onset.status, 'active', 'M0/onset : toujours champion en production ici');
    eq(V.status.M6, 'active', 'statut du modèle M6 = actif (porté par wake)');
  });

  test('M2 devient `active` sur `remaining` une fois déclenché', () => {
    const V = Stats._labView(fakeLabCases('remaining', 40, { M0: 30, M2: 5 }), Infinity);
    eq(V.byTarget.M2.remaining.status, 'active', 'M2/remaining : champion de production');
    eq(V.status.M2, 'active', 'statut du modèle M2 = actif');
  });

  test('M2v2 (`remainingV2`) n’est structurellement jamais champion', () => {
    eq(Stats.LAB_TARGETS.find(t => t.key === 'remainingV2').internal, true, 'cible marquée interne');
    ok(!Object.values(Stats.LAB_TARGET_CHAMPIONS).includes('M2v2'), 'M2v2 absent de la table des champions par cible');
  });

  test('M2v2 vs M2 : mêmes chiffres pour labExpCard (vue) et labChampionsCard (calcul direct), jamais promu, jamais dans les exports génériques', () => {
    const evs = lateSpreadEvents();
    const realEnd = add(START_LATE, 400);
    evs.push(sl(START_LATE, realEnd));
    const now = add(realEnd, 30);
    const lab = Stats.sleepLab(evs, { now, domainStart: DOMAIN, birth: BIRTH });

    ok(lab.view.byTarget.M2v2.remainingV2.status !== 'active', 'M2v2/remainingV2 : jamais actif');
    eq(lab.view.status.M2v2 === 'active', false, 'statut du modèle M2v2 : jamais actif');

    // labExpCard lit lab.view.paired.M2v2.remainingV2 ; labChampionsCard
    // appelle _labPairedM2v2VsM2 directement — même source, jamais deux
    // cartes qui se contredisent sur les mêmes chiffres.
    const direct = Stats._labPairedM2v2VsM2(lab);
    const viaView = lab.view.paired.M2v2.remainingV2;
    ok(direct.pairedN > 0, `au moins une paire M2v2/M2 (${direct.pairedN})`);
    eq(viaView.pairedN, direct.pairedN, 'même n apparié entre les deux cartes');
    eq(viaView.medianGainMin, direct.medianGainMin, 'même gain médian entre les deux cartes');
    eq(viaView.M2v2Wins, direct.M2v2Wins, 'mêmes victoires entre les deux cartes');
    eq(viaView.M2v2Losses, direct.M2v2Losses, 'mêmes défaites entre les deux cartes');

    const X = Stats.labExport(lab);
    ok(!X.pairwiseComparisonsVsChampion.some(p => p.target === 'remainingV2'), 'absent de pairwiseComparisonsVsChampion (forme M0-only)');
    ok(!X.experiments.some(e => e.experimentId.includes('remainingV2')), 'absent de experiments (même raison)');
    ok(X.pairedM2v2VsM2 && X.pairedM2v2VsM2.pairedN === direct.pairedN, 'sa propre sortie dédiée existe et correspond');
  });
};
