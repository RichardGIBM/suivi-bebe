/* =========================================================
   Prédictif sommeil — RECOS-prediction-sommeil-v5.md §3.2→§3.6
   -----------------------------------------------------------
   Ce que ces tests verrouillent en priorité :
   - les ÉCHANTILLONS (écarts d'éveil / durées) et leurs exclusions ;
   - les quantiles (médiane + P25/P75, méthode 7) et la fenêtre glissante ;
   - l'ABSENCE DE FUITE DU FUTUR dans les backtests walk-forward (le piège
     n°1 : un backtest qui triche annonce une erreur médiane flatteuse) ;
   - le chaînage AWAKE/ASLEEP et la plage calibrée sur résidus SIGNÉS.
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, near, deepEq, ok, Stats }) => {

  /* ---------- Fabrique d'événements ---------- */
  const D = (day, h, m = 0) => new Date(2026, 7, day, h, m);           // août 2026
  const iso = d => d.toISOString();
  let seq = 0;
  const sl = (start, end) => ({
    id: `s${++seq}`, action: 'sommeil', ts: iso(start),
    data: end ? { end: iso(end) } : {},
  });
  const DOMAIN = { repas: D(6, 0), couche: D(11, 0), sommeil: D(11, 0) };
  const BIRTH = new Date(2026, 7, 6, 5, 25);

  /* Scénario de référence : 6 dodos le 13 août, tous dans la fenêtre.
       E1 00:00→01:00 (60)   g1 = 60   (01:00→02:00)
       E2 02:00→03:00 (60)   g2 = 90   (03:00→04:30)
       E3 04:30→05:00 (30)   g3 = 120  (05:00→07:00)
       E4 07:00→08:00 (60)   g4 = 60   (08:00→09:00)
       E5 09:00→10:00 (60)   g5 = 120  (10:00→12:00)
       E6 12:00→13:30 (90)
     Tout est vérifiable à la main, y compris les backtests. */
  const base = () => [
    sl(D(13, 0), D(13, 1)), sl(D(13, 2), D(13, 3)), sl(D(13, 4, 30), D(13, 5)),
    sl(D(13, 7), D(13, 8)), sl(D(13, 9), D(13, 10)), sl(D(13, 12), D(13, 13, 30)),
  ];
  const NOW = D(13, 15);
  const predict = (events, now = NOW) =>
    Stats.sleepPrediction(events, { now, domainStart: DOMAIN, birth: BIRTH });

  suite('8. Prédictif — échantillons et quantiles');

  test('quantiles par interpolation linéaire (méthode 7)', () => {
    eq(Stats._median([5]), 5, 'médiane d’un seul point');
    eq(Stats._median([1, 2, 3]), 2, 'médiane impaire');
    eq(Stats._median([1, 2, 3, 4]), 2.5, 'médiane paire');
    eq(Stats._quantile([1, 2, 3, 4], 0.25), 1.75, 'P25');
    eq(Stats._quantile([1, 2, 3, 4], 0.75), 3.25, 'P75');
    eq(Stats._quantile([3, 1, 2], 0.5), 2, 'entrée non triée');
    eq(Stats._quantile([], 0.5), null, 'aucun échantillon → null');
  });

  test('écarts d’éveil et durées extraits des épisodes', () => {
    const S = Stats._predSamples(base(), { nowMs: NOW.getTime(), domainStart: DOMAIN });
    deepEq(S.durations.map(d => d.min), [60, 60, 30, 60, 60, 90], 'durées');
    deepEq(S.gaps.map(g => g.min), [60, 90, 120, 60, 120], 'écarts d’éveil');
    // atMs = instant où l'échantillon devient CONNAISSABLE (clé de l'anti-fuite)
    eq(S.gaps[0].atMs, D(13, 2).getTime(), 'un écart est connu au début du dodo suivant');
    eq(S.durations[0].atMs, D(13, 1).getTime(), 'une durée est connue à la fin du dodo');
    eq(S.ongoing, null, 'aucun dodo en cours');
  });

  test('échantillons écartés : aberrant, chevauchant, hors suivi, éveil > 12 h', () => {
    const evs = [
      sl(D(10, 20), D(10, 21)),              // avant DATA_START.sommeil (11 août)
      sl(D(11, 2), D(11, 19)),               // 17 h : aberrant
      sl(D(12, 13), D(12, 15)),
      sl(D(12, 13, 5), D(12, 15, 10)),       // doublon : chevauche le précédent
      sl(D(13, 4), D(13, 5)),                // 13 h d'éveil depuis 15:00 la veille → écart écarté
      sl(D(13, 6), D(13, 7)),                // 1 h d'éveil : conservé
    ];
    const S = Stats._predSamples(evs, { nowMs: NOW.getTime(), domainStart: DOMAIN });
    deepEq(S.excluded, { avantSuivi: 1, aberrants: 1, chevauchants: 1, eveilTropLong: 1, eveilNegatif: 0 }, 'motifs d’exclusion');
    deepEq(S.durations.map(d => d.min), [120, 60, 60], 'durées retenues');
    // L'ancre de l'écart est la fin du dodo RETENU (15:00), pas celle du doublon
    // écarté (15:10) : un doublon ne doit rien décaler.
    deepEq(S.gaps.map(g => g.min), [60], 'un seul écart plausible : 05:00 → 06:00');
  });

  test('fenêtre glissante : min(14 jours civils, 40 échantillons), passé seulement', () => {
    const asOf = D(13, 12).getTime();
    const mk = (day, h, min) => ({ atMs: D(day, h).getTime(), min });
    const s = [mk(13 - 14, 23, 1), mk(13 - 13, 0, 2), mk(13, 10, 3), mk(13, 23, 4)];
    const w = Stats._predWindow(s, asOf, Stats.WW_WINDOW_DAYS, Stats.WW_WINDOW_MAX_SAMPLES);
    deepEq(w.map(x => x.min), [2, 3], '14e jour révolu exclu, futur exclu');
    const many = Array.from({ length: 60 }, (_, i) => ({ atMs: D(13, 0).getTime() + i * 60000, min: i }));
    const w2 = Stats._predWindow(many, asOf, 14, 40);
    eq(w2.length, 40, 'plafond à 40 échantillons');
    deepEq([w2[0].min, w2[39].min], [20, 59], 'les 40 DERNIERS échantillons');
  });

  test('médiane dès n=1, plage seulement à partir de n=3', () => {
    const one = predict([sl(D(13, 12), D(13, 13))]);
    eq(one.duration.n, 1, 'une durée connue');
    eq(one.duration.medianMin, 60, 'médiane affichable dès n=1');
    eq(one.duration.p25Min, null, 'pas de plage à n=1');
    ok(one.ready, 'onglet affichable dès 1 point de donnée');
    eq(predict([]).ready, false, 'aucun point : onglet masqué');

    const three = predict(base().slice(0, 4));
    eq(three.onset.n, 3, 'trois écarts');
    near(three.onset.medianMin, 90, 0.001, 'médiane des écarts');
    near(three.onset.p25Min, 75, 0.001, 'P25 dès n=3');
    near(three.onset.p75Min, 105, 0.001, 'P75 dès n=3');
  });

  suite('9. Prédictif — backtests walk-forward (aucune fuite du futur)');

  test('backtest écart d’éveil : entraînement strictement antérieur', () => {
    const p = predict(base());
    // g4 et g5 seuls ont ≥ 3 écarts connus AVANT eux (seuil BACKTEST_MIN_TRAIN_SAMPLES).
    eq(p.quality1.n, 2, 'deux backtests possibles');
    deepEq(p.quality1.rows.map(r => r.trainN), [3, 4], 'taille d’entraînement croissante');
    eq(p.quality1.rows[0].anchorMs, D(13, 8).getTime(), 'prédiction faite au réveil de 08:00');
    eq(p.quality1.rows[0].predMs, D(13, 9, 30).getTime(), 'médiane(60,90,120)=90 → 09:30');
    eq(p.quality1.rows[0].realMs, D(13, 9).getTime(), 'endormissement réel 09:00');
    near(p.quality1.rows[0].errMin, -30, 0.001, 'erreur signée = réel - prévu');
    near(p.quality1.rows[1].errMin, 45, 0.001, 'médiane(60,90,120,60)=75 → 120-75');
    near(p.quality1.medAbsMin, 37.5, 0.001, 'erreur absolue médiane');
  });

  test('backtest durée : la durée du dodo en cours n’est jamais utilisée', () => {
    const p = predict(base());
    eq(p.quality2.n, 3, 'trois backtests de durée');
    deepEq(p.quality2.rows.map(r => Math.round(r.errMin)), [0, 0, 30], 'erreurs signées');
    near(p.quality2.medAbsMin, 0, 0.001, 'erreur médiane');
    near(p.quality2.p80AbsMin, 18, 0.001, 'P80 des erreurs absolues');
    // Un dodo en cours n'apporte ni durée ni backtest supplémentaire.
    const q = predict(base().concat([sl(D(13, 14, 30), null)]));
    eq(q.quality2.n, 3, 'toujours trois backtests');
    eq(q.duration.n, 6, 'six durées connues (l’épisode en cours exclu)');
  });

  test('backtest aller-retour : résidus SIGNÉS du réveil prévu', () => {
    const p = predict(base());
    eq(p.roundtrip.n, 2, 'deux allers-retours vérifiables');
    eq(p.roundtrip.rows[0].predMs, D(13, 10, 30).getTime(), '08:00 + 90 (éveil) + 60 (dodo)');
    eq(p.roundtrip.rows[0].realMs, D(13, 10).getTime(), 'réveil réel 10:00');
    near(p.roundtrip.rows[0].errMin, -30, 0.001, 'réveil 30 min plus tôt que prévu');
    near(p.roundtrip.rows[1].errMin, 75, 0.001, 'réveil 75 min plus tard que prévu');
    near(p.roundtrip.p25SignedMin, -3.75, 0.001, 'P25 des résidus signés');
    near(p.roundtrip.p75SignedMin, 48.75, 0.001, 'P75 des résidus signés');
    near(p.roundtrip.medAbsMin, 52.5, 0.001, 'performance = erreurs ABSOLUES');
  });

  test('recul et performance restent deux mesures distinctes', () => {
    const rows = n => Array.from({ length: n }, (_, i) => ({ errMin: i % 2 ? 10 : -10 }));
    eq(Stats._predQuality(rows(19), 20, 40).tier, 'debut', 'n<20 : peu de recul');
    eq(Stats._predQuality(rows(20), 20, 40).tier, 'intermediaire', 'n=20 : recul intermédiaire');
    eq(Stats._predQuality(rows(40), 20, 40).tier, 'solide', 'n=40 : recul important');
    const q = Stats._predQuality(rows(60), 20, 40);
    eq(q.n, 60, 'recul = tous les backtests accumulés');
    eq(q.recentN, 40, 'performance mesurée sur les 40 derniers');
    near(q.medAbsMin, 10, 0.001, 'erreur absolue médiane');
    near(q.medSignedMin, 0, 0.001, 'biais nul : les erreurs signées se compensent');
  });

  suite('10. Prédictif — état, chaînage et affichage');

  test('ÉVEILLÉ : endormissement ancré au dernier réveil, réveil chaîné', () => {
    const p = predict(base());
    eq(p.state, 'AWAKE', 'état');
    eq(p.sinceMs, D(13, 13, 30).getTime(), 'éveillé depuis le dernier réveil');
    near(p.sinceMin, 90, 0.001, 'minutes d’éveil');
    near(p.onset.medianMin, 90, 0.001, 'éveil médian');
    eq(p.onset.anchorMs, D(13, 13, 30).getTime(), 'ancre = dernier réveil');
    eq(p.onset.atMs, D(13, 15).getTime(), 'endormissement prévu 15:00');
    eq(p.onset.loMs, D(13, 14, 30).getTime(), 'borne basse = ancre + P25');
    eq(p.onset.hiMs, D(13, 15, 30).getTime(), 'borne haute = ancre + P75');
    eq(p.wake.basis, 'roundtrip', 'plage du réveil calibrée sur l’aller-retour');
    eq(p.wake.atMs, D(13, 16).getTime(), 'réveil prévu = endormissement prévu + durée médiane');
    near((p.wake.loMs - p.wake.atMs) / 60000, -3.75, 0.001, 'borne basse = prévu + P25 signé');
    near((p.wake.hiMs - p.wake.atMs) / 60000, 48.75, 0.001, 'borne haute = prévu + P75 signé');
  });

  test('ÉVEILLÉ sans aller-retour vérifié : repli explicite sur la somme des plages', () => {
    // 4 dodos : 3 écarts (plage possible) mais aucun aller-retour (il en faut
    // 3 d'éveil ET 3 de durée connus AVANT le réveil de référence).
    const p = predict(base().slice(0, 4));
    eq(p.roundtrip.n, 0, 'aucun aller-retour vérifié');
    eq(p.wake.basis, 'somme', 'repli annoncé comme tel');
    near((p.wake.loMs - p.onset.anchorMs) / 60000, 75 + 52.5, 0.001, 'P25 éveil + P25 durée');
    near((p.wake.hiMs - p.onset.anchorMs) / 60000, 105 + 60, 0.001, 'P75 éveil + P75 durée');
    // Empiler deux P25/P75 indépendants donne une plage plus large que celle
    // calibrée sur les erreurs réelles : d'où le repli explicite (§3.4).
    ok((p.wake.hiMs - p.wake.loMs) > 30 * 60000, 'plage du repli volontairement large');
  });

  test('ENDORMI : réveil estimé depuis l’endormissement RÉEL', () => {
    const evs = base().concat([sl(D(13, 14, 30), null)]);
    const p = predict(evs, D(13, 15));
    eq(p.state, 'ASLEEP', 'état');
    eq(p.sinceMs, D(13, 14, 30).getTime(), 'endormi depuis 14:30');
    eq(p.wake.basis, 'duree', 'plage = P25/P75 des durées récentes');
    eq(p.wake.atMs, D(13, 15, 30).getTime(), '14:30 + durée médiane (60 min)');
    eq(p.wake.beyondRange, false, 'on est encore dans la plage');
    const tard = predict(evs, D(13, 16, 30));
    eq(tard.wake.beyondRange, true, 'au-delà de la plage habituelle observée');
    near(tard.sinceMin, 120, 0.001, 'endormi depuis 2 h');
  });

  test('plage large de durée signalée (siestes courtes + nuits longues)', () => {
    const evs = [
      sl(D(12, 10), D(12, 10, 20)), sl(D(12, 12), D(12, 12, 25)),
      sl(D(12, 14), D(12, 14, 30)), sl(D(12, 22), D(13, 6)),
      sl(D(13, 8), D(13, 8, 20)), sl(D(13, 20), D(14, 4)),
    ];
    const p = predict(evs, D(14, 8));
    ok(p.duration.iqrRatio > Stats.SD_MAX_IQR_MEDIAN_RATIO, `ratio IQR/médiane = ${p.duration.iqrRatio}`);
    eq(p.duration.wide, true, 'avertissement « plage large »');
    eq(predict(base()).duration.wide, false, 'durées homogènes : pas d’avertissement');
  });

  test('contexte : âge, jours de sommeil suivis, dodo en cours', () => {
    const p = predict(base());
    eq(p.context.ageDays, 7, 'né le 6 août → 7 j le 13 août');
    eq(p.context.trackedSleepDays, 1, 'un seul jour civil avec du sommeil');
    eq(p.context.episodesN, 6, 'six épisodes retenus');
    eq(p.context.lastWakeMs, D(13, 13, 30).getTime(), 'dernier réveil');
    eq(p.context.sleepStartMs, null, 'pas de dodo en cours');
    // Un dodo à cheval sur minuit compte pour les deux jours (règle des segments).
    const nuit = predict([sl(D(12, 22), D(13, 6))], D(13, 8));
    eq(nuit.context.trackedSleepDays, 2, 'nuit à cheval : 2 jours suivis');
  });

  test('robustesse : données sales, ordre d’arrivée, aucun nombre non fini', () => {
    const sale = [
      { id: 'x1', action: 'sommeil', ts: 'nawak' },
      { id: 'x2', action: 'sommeil', ts: iso(D(13, 3)), data: { end: 'nawak' } },
      { id: 'x3', action: 'sommeil', ts: iso(D(11, 4)) },                       // data absente + dodo oublié (> 16 h)
      { id: 'x4', action: 'tetee', ts: iso(D(13, 5)), data: { side: 'gauche' } },
      { id: 'x5', action: 'sommeil', ts: iso(D(13, 6)), data: { end: iso(D(13, 5)) } }, // end < start
      { id: 'x6', action: 'sommeil', ts: iso(D(13, 7)), data: { end: iso(D(13, 8)) }, deleted: true },
      ...base(),
    ];
    const p = predict(sale);
    const scan = (o, chemin = '') => {
      if (typeof o === 'number') ok(Number.isFinite(o), `${chemin} = ${o}`);
      else if (Array.isArray(o)) o.forEach((v, i) => scan(v, `${chemin}[${i}]`));
      else if (o && typeof o === 'object') for (const k in o) scan(o[k], `${chemin}.${k}`);
    };
    scan(p, 'prediction');
    eq(p.state, 'AWAKE', 'état inchangé malgré les événements sales');
    eq(p.duration.n, 6, 'tombstone et données invalides ignorés');

    const melange = [...sale].reverse();
    deepEq(JSON.parse(JSON.stringify(predict(melange))), JSON.parse(JSON.stringify(p)),
      'résultat indépendant de l’ordre d’arrivée');
  });
};
