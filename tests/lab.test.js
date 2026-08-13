/* =========================================================
   Laboratoire Champion / Challengers — RECOS-prediction-sommeil-v5.md
   §3.8, §3.10, §3.12, §3.13, §3.14
   -----------------------------------------------------------
   Ce que ces tests verrouillent en priorité :
   - AUCUNE FUITE DU FUTUR : ajouter des dodos postérieurs ne doit rien
     changer à un cas déjà joué (c'est toute la valeur de l'écran) ;
   - la convention de signe du gain apparié — une inversion rendrait le
     laboratoire exactement trompeur — et l'appariement strict ;
   - l'échelle des statuts, le plafond de confirmations simultanées, et le
     fait qu'aucun modèle ne devient `active` tout seul ;
   - les checkpoints : la vue « au jour J » doit être ce que l'app aurait
     calculé ce jour-là avec les seuls événements connus ;
   - l'export LLM : schéma, conventions embarquées, dé-identification.

   Deux jeux de données, volontairement :
   - un HISTORIQUE synthétique long (nuits longues, siestes courtes) pour les
     propriétés qui demandent du volume et des semaines d'âge ;
   - des CAS FABRIQUÉS pour les mécaniques (signe du gain, gel, file
     d'attente) : leur verdict ne doit pas dépendre du hasard du jeu de test.
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, near, deepEq, ok, Stats }) => {

  /* ---------- Fabrique d'événements ---------- */
  const iso = d => d.toISOString();
  let seq = 0;
  const sl = (start, end) => ({
    id: `s${++seq}`, action: 'sommeil', ts: iso(start),
    data: end ? { end: iso(end) } : {},
  });
  const BIRTH = new Date(2026, 7, 6, 5, 25);              // 6 août 2026, 5h25
  const DOMAIN = { repas: new Date(2026, 7, 6), couche: new Date(2026, 7, 11), sommeil: new Date(2026, 7, 11) };

  /* Historique DÉTERMINISTE (aucun Math.random : un test qui change de verdict
     d'un run à l'autre ne verrouille rien). Nuits longues 20h→7h, siestes
     courtes le jour : de quoi faire réellement diverger les modèles horaires
     et segmentés. `history(t2)` prolonge `history(t1)` à l'identique, ce qui
     permet le test d'absence de fuite. */
  let rng = 12345;
  const rnd = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
  function history(untilMs, from = new Date(2026, 7, 11, 7, 0)) {
    rng = 12345;
    const evs = [];
    let t = from.getTime();
    while (t < untilMs) {
      const h0 = new Date(t).getHours();
      const startMs = t + Math.round((h0 >= 20 || h0 < 7) ? 25 + rnd() * 35 : 55 + rnd() * 65) * 60000;
      const hs = new Date(startMs).getHours();
      const endMs = startMs + Math.round((hs >= 20 || hs < 6) ? 170 + rnd() * 200 : 45 + rnd() * 80) * 60000;
      evs.push(sl(new Date(startMs), new Date(endMs)));
      t = endMs;
    }
    return { evs, lastMs: t };
  }
  const H = history(new Date(2026, 11, 1).getTime());     // 11 août → 1er déc (bébé ~S16)
  const NOW = new Date(H.lastMs + 40 * 60000);
  const L = Stats.sleepLab(H.evs, { now: NOW, domainStart: DOMAIN, birth: BIRTH });
  const CH = L.championId;
  const eps = 1e-9;

  /* Cas fabriqués : `errs` = erreur signée voulue, par modèle. */
  const fakeCases = (target, n, errs) => Array.from({ length: n }, (_, i) => {
    const preds = {};
    for (const id of Object.keys(errs)) {
      preds[id] = {
        predMin: id === 'M0' ? 0 : 1,                     // predMin ≠ celui de M0 ⇒ `diverged`
        predMs: 0, signedErrMin: errs[id], absErrMin: Math.abs(errs[id]),
      };
    }
    return {
      id: `${target}-${String(i + 1).padStart(4, '0')}`, target,
      asOfMs: i, anchorMs: 0, realMs: (i + 1) * 3600000, realMin: 0,
      ageDays: Math.floor(i / 6), features: {}, preds,
    };
  });

  suite('11. Laboratoire — cas walk-forward et absence de fuite du futur');

  test('le catalogue déclare le même langage pour l’UI, les snapshots et l’export', () => {
    eq(CH, 'M0', 'champion');
    eq(Stats.LAB_MODELS.filter(m => m.champion).length, 1, 'un seul champion');
    for (const m of Stats.LAB_MODELS) {
      ok(/^M\d+$/.test(m.id), `id ${m.id}`);
      ok(typeof m.label === 'string' && m.label, `label de ${m.id}`);
      eq(typeof m.version, 'number', `version de ${m.id}`);
      ok(Array.isArray(m.targets) && Array.isArray(m.features), `targets/features de ${m.id}`);
      ok(m.parameters && typeof m.parameters === 'object', `parameters de ${m.id}`);
      m.targets.forEach(t => ok(Stats.LAB_TARGETS.some(x => x.key === t), `${m.id} : cible connue ${t}`));
    }
  });

  test('M8 (hybride) est déclaré mais NON instancié — discipline d’attribution', () => {
    const m8 = Stats.LAB_MODELS.find(m => m.id === 'M8');
    eq(m8.predict, null, 'aucun estimateur');
    deepEq(m8.targets, [], 'aucune cible');
    ok(/3\.8\.6/.test(m8.blocked), 'la raison cite la règle des effets simples');
    eq(L.view.status.M8, 'collecting', 'reste en collecte');
    const rows = L.nowRows.filter(r => r.modelId === 'M8');
    ok(rows.length > 0, 'M8 apparaît quand même dans « Maintenant »');
    ok(rows.every(r => !r.applicable && r.predMs == null && r.reason), 'jamais de valeur fabriquée pour M8');
  });

  test('chaque cas est ancré AVANT sa vérité, et les erreurs sont cohérentes', () => {
    ok(L.cases.length > 500, `cas produits (${L.cases.length})`);
    let prev = -Infinity, preds = 0;
    for (const c of L.cases) {
      ok(c.asOfMs <= c.realMs, `${c.id} : asOfMs ≤ realMs`);
      ok(c.realMs >= prev - eps, `${c.id} : cas triés par vérité`);
      prev = c.realMs;
      ok(c.ageDays >= 0, `${c.id} : âge en jours`);
      for (const id of Object.keys(c.preds)) {
        const p = c.preds[id];
        ok(Stats._labModel(id).targets.includes(c.target), `${c.id} : ${id} prédit bien cette cible`);
        near(p.predMs, c.anchorMs + p.predMin * 60000, 1e-6, `${c.id}/${id} : prédiction ancrée`);
        near(p.signedErrMin, (c.realMs - p.predMs) / 60000, 1e-6, `${c.id}/${id} : erreur signée = réel − prévu`);
        near(p.absErrMin, Math.abs(p.signedErrMin), 1e-9, `${c.id}/${id} : erreur absolue`);
        preds++;
      }
    }
    ok(preds > 2000, `prédictions produites (${preds})`);
  });

  test('AUCUNE FUITE : ajouter des dodos postérieurs ne change aucun cas passé', () => {
    // Deux semaines de dodos en plus (et un `now` plus tard) : chaque cas déjà
    // présent doit rendre EXACTEMENT les mêmes prédictions, sous le même id.
    const plus = history(new Date(2026, 11, 15).getTime());
    const L2 = Stats.sleepLab(plus.evs, {
      now: new Date(plus.lastMs + 40 * 60000), domainStart: DOMAIN, birth: BIRTH,
    });
    ok(L2.cases.length > L.cases.length, `le laboratoire étendu a plus de cas (${L2.cases.length} > ${L.cases.length})`);
    const byId = new Map(L2.cases.map(c => [c.id, c]));
    let compares = 0;
    for (const c of L.cases) {
      const c2 = byId.get(c.id);
      ok(c2, `${c.id} : identifiant stable d’un export à l’autre`);
      eq(c2.realMs, c.realMs, `${c.id} : même vérité`);
      eq(c2.anchorMs, c.anchorMs, `${c.id} : même ancre`);
      deepEq(Object.keys(c2.preds).sort(), Object.keys(c.preds).sort(), `${c.id} : mêmes modèles calculables`);
      for (const id of Object.keys(c.preds)) {
        near(c2.preds[id].predMin, c.preds[id].predMin, 1e-9, `${c.id}/${id} : prédiction inchangée`);
        compares++;
      }
    }
    ok(compares > 2000, `prédictions comparées (${compares})`);
  });

  test('la sonde `remaining` est exactement l’heure que M0 avait annoncée', () => {
    const rem = L.cases.filter(c => c.target === 'remaining');
    ok(rem.length > 20, `cas remaining (${rem.length})`);
    const wakeByAnchor = new Map(L.cases.filter(c => c.target === 'wake').map(c => [c.anchorMs, c]));
    for (const c of rem) {
      ok(c.realMs > c.anchorMs, `${c.id} : la sonde précède le réveil réel`);
      ok(c.features.elapsedSleepMin > 0, `${c.id} : du sommeil déjà écoulé`);
      near(c.realMin, (c.realMs - c.anchorMs) / 60000, 1e-6, `${c.id} : durée restante`);
      const w = wakeByAnchor.get(c.anchorMs - c.features.elapsedSleepMin * 60000);
      ok(w, `${c.id} : rattaché à l’épisode dont il ré-estime le réveil`);
      eq(w.realMs, c.realMs, `${c.id} : même réveil réel que la cible wake`);
      // La ré-estimation n'a lieu qu'au moment où le champion s'est trompé : la
      // sonde est posée sur SA prédiction, pas à une heure arbitraire.
      near(c.anchorMs, w.preds.M0.predMs, 1e-6, `${c.id} : sonde = réveil annoncé par M0`);
      // M2 ne garde que les dodos plus longs que le temps déjà écoulé : il ne
      // peut donc jamais annoncer un réveil déjà passé.
      if (c.preds.M2) ok(c.preds.M2.predMin > 0, `${c.id} : M2 ne remonte pas dans le passé`);
    }
  });

  test('un modèle qui ne sait pas répondre rend `null`, jamais une valeur fabriquée', () => {
    const petit = [sl(new Date(2026, 7, 12, 9), new Date(2026, 7, 12, 10)),
      sl(new Date(2026, 7, 12, 12), new Date(2026, 7, 12, 13))];
    const P = Stats.sleepLab(petit, { now: new Date(2026, 7, 12, 14), domainStart: DOMAIN, birth: BIRTH });
    // Les cas existent (2 dodos ⇒ 1 endormissement + 2 réveils, aucune sonde
    // `remaining` faute d'historique), triés par la date de leur vérité :
    // réveil 10 h, endormissement 12 h, réveil 13 h…
    deepEq(P.cases.map(c => c.target), ['wake', 'onset', 'wake'], 'cas observés');
    deepEq(P.cases.map(c => c.id), ['wake-0001', 'onset-0001', 'wake-0002'], 'numérotation par cible');
    // …mais AUCUN modèle ne se prononce : trois échantillons minimum.
    ok(P.cases.every(c => Object.keys(c.preds).length === 0), 'aucune prédiction fabriquée');
    ok(P.nowRows.length > 0, 'le tableau « Maintenant » existe quand même');
    ok(P.nowRows.every(r => r.predMs == null && r.deltaVsChampionMin == null), 'aucune prédiction affichée');
    ok(P.nowRows.every(r => r.reason), 'chaque case vide porte sa raison');
    ok(Stats.LAB_MODELS.every(m => m.targets.every(t => !P.view.perf[m.id][t].n)), 'aucune métrique inventée');
    eq(P.view.status.M0, 'active', 'M0 reste le modèle affiché');
    eq(Object.values(P.view.status).filter(s => s === 'active').length, 1, 'personne d’autre n’est actif');
    eq(Object.values(P.view.status).filter(s => s === 'collecting').length,
      Stats.LAB_MODELS.length - 1, 'tous les challengers en collecte');
    eq(P.counts.cases, 3, 'compteur de cas');
    deepEq(P.weekly, [], 'aucune évolution hebdomadaire à montrer');
  });

  suite('12. Laboratoire — gain apparié, statuts et confirmation');

  test('gain apparié : |erreur M0| − |erreur Mx|, sur exactement les mêmes cas', () => {
    let vus = 0;
    for (const m of Stats.LAB_MODELS) {
      if (m.id === CH || !m.predict) continue;
      for (const t of m.targets) {
        const p = L.view.paired[m.id][t];
        const rows = L.cases.filter(c => c.target === t && c.preds[m.id] && c.preds[CH]);
        eq(p.pairedN, rows.length, `${m.id}/${t} : appariement strict (les 2 modèles ont prédit)`);
        if (!p.pairedN) continue;
        vus++;
        const gains = rows.map(c => c.preds[CH].absErrMin - c.preds[m.id].absErrMin);
        near(p.medianGainMin, Stats._median(gains), 1e-9, `${m.id}/${t} : gain médian`);
        near(p.p25GainMin, Stats._quantile(gains, 0.25), 1e-9, `${m.id}/${t} : P25 du gain`);
        near(p.p75GainMin, Stats._quantile(gains, 0.75), 1e-9, `${m.id}/${t} : P75 du gain`);
        eq(p.wins + p.ties + p.losses, p.pairedN, `${m.id}/${t} : victoires + égalités + défaites = n`);
        eq(p.wins, gains.filter(g => g > eps).length, `${m.id}/${t} : une victoire = gain > 0`);
        eq(p.losses, gains.filter(g => g < -eps).length, `${m.id}/${t} : une défaite = gain < 0`);
        near(p.championMedAbsMin, Stats._median(rows.map(c => c.preds[CH].absErrMin)), 1e-9, `${m.id}/${t} : erreur médiane de M0`);
        near(p.challengerMedAbsMin, Stats._median(rows.map(c => c.preds[m.id].absErrMin)), 1e-9, `${m.id}/${t} : erreur médiane du challenger`);
        near(p.challengerMedSignedMin, Stats._median(rows.map(c => c.preds[m.id].signedErrMin)), 1e-9, `${m.id}/${t} : biais signé`);
        eq(p.firstComparableMs, rows[0].realMs, `${m.id}/${t} : premier cas comparable`);
        ok(p.recentShortN <= Stats.LAB_RECENT_SHORT_N, `${m.id}/${t} : « derniers cas » borné`);
      }
    }
    ok(vus >= 5, `expériences comparées à M0 (${vus})`);
  });

  test('le signe du gain est bien celui de la spec (un challenger meilleur gagne)', () => {
    // M0 se trompe de 20 min et le challenger de 5 → gain = +15.
    const cs = fakeCases('wake', 2, { M0: 20, M5: 5 });
    cs[1].preds.M0 = { predMin: 0, predMs: 0, signedErrMin: -10, absErrMin: 10 };
    cs[1].preds.M5 = { predMin: 1, predMs: 0, signedErrMin: -30, absErrMin: 30 };
    const p = Stats._labPaired(cs, 'M5', 'wake');
    eq(p.pairedN, 2, 'deux cas appariés');
    near(p.medianGainMin, (15 - 20) / 2, 1e-9, 'gain médian = médiane(+15, −20)');
    eq(p.wins, 1, 'une victoire');
    eq(p.losses, 1, 'une défaite');
    eq(p.ties, 0, 'aucune égalité');
    eq(p.p25GainMin, null, 'pas de plage sur 2 points');
    near(p.challengerMedSignedMin, (5 - 30) / 2, 1e-9, 'biais signé du challenger');
    eq(p.diverged, true, 'les deux modèles ne disent pas la même chose');
    // Deux modèles qui donnent exactement la même chose : que des égalités.
    const jum = fakeCases('wake', 4, { M0: 7, M1: 7 });
    jum.forEach(c => { c.preds.M1.predMin = 0; });
    const q = Stats._labPaired(jum, 'M1', 'wake');
    eq(q.ties, 4, 'que des égalités');
    eq(q.wins + q.losses, 0, 'ni victoire ni défaite');
    near(q.medianGainMin, 0, 1e-9, 'gain nul');
    eq(q.diverged, false, 'aucune divergence');
  });

  test('gel pour confirmation : bloc exploratoire et bloc de confirmation disjoints', () => {
    const cs = fakeCases('wake', 60, { M0: 25, M5: 5 });      // gain constant de 20 min
    const p = Stats._labPaired(cs, 'M5', 'wake');
    eq(p.pairedN, 60, 'cas appariés');
    eq(p.freezeAt, Stats.FEATURE_CONFIRM_TRIGGER_N - 1, 'gel dès que le seuil de cas est atteint');
    eq(p.freezeMs, cs[Stats.FEATURE_CONFIRM_TRIGGER_N - 1].realMs, 'date du gel');
    eq(p.exploration.pairedN, Stats.FEATURE_CONFIRM_TRIGGER_N, 'bloc exploratoire');
    near(p.exploration.medianGainMin, 20, 1e-9, 'gain exploratoire');
    eq(p.confirmation.targetN, Stats.FEATURE_CONFIRM_N, 'cible du bloc de confirmation');
    eq(p.confirmation.currentN, 60 - Stats.FEATURE_CONFIRM_TRIGGER_N, 'cas de confirmation (non recouvrants)');
    eq(p.exploration.pairedN + p.confirmation.currentN, p.pairedN, 'blocs disjoints et complets');
    eq(p.confirmation.complete, true, 'bloc de confirmation atteint');
    near(p.confirmation.medianGainMin, 20, 1e-9, 'gain de confirmation');

    // Gain réel mais inférieur au seuil « pratiquement intéressant » : pas de gel.
    const petit = Stats._labPaired(fakeCases('wake', 60, { M0: 6, M5: 4 }), 'M5', 'wake');
    near(petit.medianGainMin, 2, 1e-9, 'gain de 2 min');
    eq(petit.freezeAt, null, `sous ${Stats.FEATURE_MIN_GAIN_MIN_MS / 60000} min de gain, rien n’est gelé`);
    eq(petit.confirmation, null, 'aucun bloc de confirmation');
    eq(Stats._labPaired(fakeCases('wake', 60, { M0: 5, M5: 25 }), 'M5', 'wake').freezeAt, null,
      'un challenger perdant ne gèle pas');
  });

  test('au plus FEATURE_MAX_CONCURRENT_TRIALS confirmations simultanées, les autres en file', () => {
    const V = Stats._labView(fakeCases('onset', 60, { M0: 25, M1: 5, M3: 5, M6: 5 }), Infinity);
    eq(Stats.FEATURE_MAX_CONCURRENT_TRIALS, 2, 'plafond du §3.10');
    eq(V.byTarget.M1.onset.status, 'confirming', 'M1 gelé');
    eq(V.byTarget.M3.onset.status, 'confirming', 'M3 gelé');
    eq(V.byTarget.M6.onset.status, 'exploration', 'M6 attend son tour');
    eq(V.byTarget.M6.onset.queued, true, 'et le dit');
    ok(/file d’attente/.test(V.byTarget.M6.onset.why), 'raison affichable');
    eq(V.status.M1, 'confirming', 'statut du modèle = son expérience la plus avancée');
    eq(V.status.M0, 'active', 'le champion reste actif');
    eq(V.byTarget.M4.onset.status, 'collecting', 'un modèle sans cas comparable reste en collecte');
    for (const v of [L.view, ...L.checkpoints.filter(c => c.view).map(c => c.view)]) {
      let n = 0;
      for (const m of Stats.LAB_MODELS) for (const t of m.targets) if (v.byTarget[m.id][t].status === 'confirming') n++;
      ok(n <= Stats.FEATURE_MAX_CONCURRENT_TRIALS, `vue réelle : ${n} confirmation(s) simultanée(s)`);
    }
  });

  test('échelle des statuts : jamais déduite de l’âge, jamais promue toute seule', () => {
    deepEq(Stats.LAB_STATUS_ORDER, ['collecting', 'shadow', 'exploration', 'confirming', 'active', 'rejected'], 'cycle de vie');
    for (const m of Stats.LAB_MODELS) {
      for (const t of m.targets) {
        const bt = L.view.byTarget[m.id][t];
        ok(Stats.LAB_STATUS_ORDER.includes(bt.status), `${m.id}/${t} : statut connu`);
        ok(bt.why, `${m.id}/${t} : raison affichable`);
        if (m.id === CH) { eq(bt.status, 'active', 'seul le champion est actif'); continue; }
        eq(bt.status === 'active', false, `${m.id}/${t} : aucun challenger ne s’active tout seul`);
        eq(bt.status === 'rejected', false, `${m.id}/${t} : aucun rejet automatique`);
        const p = L.view.paired[m.id][t];
        if (!p.pairedN) { eq(bt.status, 'collecting', `${m.id}/${t} : sans cas apparié → collecte`); continue; }
        if (m.requiresDivergence && !p.diverged) { eq(bt.status, 'collecting', `${m.id}/${t} : sans divergence → collecte`); continue; }
        if (p.pairedN < Stats.FEATURE_EXPLORATION_MIN_PAIRED_N) eq(bt.status, 'shadow', `${m.id}/${t} : ${p.pairedN} cas → shadow`);
        else if (p.freezeAt != null && !bt.queued) eq(bt.status, 'confirming', `${m.id}/${t} : gelé → confirmation`);
        else eq(bt.status, 'exploration', `${m.id}/${t} : assez de cas → exploration`);
      }
    }
    eq(Object.values(L.view.status).filter(s => s === 'active').length, 1, 'un seul modèle actif dans tout le laboratoire');
  });

  test('l’évolution hebdomadaire ne mélange pas les semaines', () => {
    ok(L.weekly.length > 0, `lignes hebdo (${L.weekly.length})`);
    for (const w of L.weekly) {
      const cs = L.cases.filter(c => c.target === w.target && c.preds[w.challengerId] && c.preds[CH]
        && Math.floor(c.ageDays / 7) === w.ageWeek);
      eq(w.pairedN, cs.length, `S${w.ageWeek}/${w.challengerId}/${w.target} : n de la semaine`);
      eq(w.championId, CH, 'référence = champion');
      near(w.medianGainMin, Stats._median(cs.map(c => c.preds[CH].absErrMin - c.preds[w.challengerId].absErrMin)),
        1e-9, `S${w.ageWeek}/${w.challengerId}/${w.target} : gain de la semaine`);
      near(w.championMedAbsMin, Stats._median(cs.map(c => c.preds[CH].absErrMin)), 1e-9,
        `S${w.ageWeek}/${w.challengerId}/${w.target} : erreur de M0 cette semaine-là`);
    }
    eq(L.weekly.filter(w => w.challengerId === CH).length, 0, 'le champion n’est pas son propre challenger');
    eq(L.weekly.reduce((s, w) => s + w.pairedN, 0),
      Stats.LAB_MODELS.filter(m => m.id !== CH && m.predict).reduce((s, m) => s + m.targets.reduce(
        (x, t) => x + L.view.paired[m.id][t].pairedN, 0), 0),
      'toutes les paires tombent dans une semaine et une seule');
  });

  suite('13. Laboratoire — checkpoints reconstructibles');

  test('les rendez-vous de lecture sont ceux du §3.13, avec leur focus', () => {
    const keys = L.checkpoints.map(c => c.key);
    eq(keys[0], 'now', 'Aujourd’hui en tête');
    for (const w of Stats.LAB_CHECKPOINT_WEEKS) ok(keys.includes(`S${w}`), `S${w} présent`);
    const s8 = L.checkpoints.find(c => c.key === 'S8');
    deepEq(s8.focusModels, ['M3'], 'S8 = checkpoint heure (M3)');
    eq(s8.dateMs, Stats.startOfDay(Stats.addDays(Stats.startOfDay(BIRTH), 56)).getTime(), 'S8 = naissance + 56 jours');
    deepEq(L.checkpoints.find(c => c.key === 'S10').focusModels, ['M4', 'M5'], 'S10 = mémoire courte');
    deepEq(L.checkpoints.find(c => c.key === 'S16').focusModels, ['M7'], 'S16 = récence adaptative');
    // Au-delà de S16 : revue générale toutes les 4 semaines, sur tous les challengers.
    const gen = L.checkpoints.find(c => c.week != null && c.week > 16);
    ok(gen, 'la cadence continue après S16');
    eq(gen.week, 20, 'S20');
    eq(gen.focusModels.length, Stats.LAB_MODELS.length - 1, 'revue générale = tous les challengers');
    L.checkpoints.forEach(c => {
      eq(c.future, c.dateMs > L.nowMs, `${c.key} : drapeau « à venir »`);
      eq(!!c.view, !c.future, `${c.key} : vue disponible seulement si la date est passée`);
      ok(c.focus && c.watch, `${c.key} : focus et question de lecture`);
    });
  });

  test('un checkpoint = ce que l’app aurait calculé ce jour-là (pas une relecture avec le futur)', () => {
    // Reconstruction honnête : on ne garde que les événements connus à T (un
    // dodo commencé mais pas fini y est « en cours »), puis on recalcule tout
    // depuis zéro avec now = T. Les deux vues doivent coïncider exactement.
    const cp = L.checkpoints.filter(c => c.view && c.week != null).pop();
    ok(cp, 'au moins un checkpoint passé');
    const T = cp.dateMs;
    const connus = H.evs.filter(e => new Date(e.ts).getTime() <= T).map(e => {
      const end = e.data && e.data.end ? new Date(e.data.end).getTime() : null;
      return (end != null && end > T) ? { ...e, data: {} } : e;      // dodo encore en cours à T
    });
    const R = Stats.sleepLab(connus, { now: new Date(T), domainStart: DOMAIN, birth: BIRTH });

    ok(cp.view.casesN > 100, `${cp.key} : cas connus (${cp.view.casesN})`);
    eq(cp.view.casesN, R.view.casesN, `${cp.key} : même nombre de cas connus`);
    deepEq(L.cases.filter(c => c.realMs <= T).map(c => c.id), R.cases.map(c => c.id),
      `${cp.key} : mêmes cas, mêmes identifiants`);
    for (const m of Stats.LAB_MODELS) {
      for (const t of m.targets) {
        const a = cp.view.perf[m.id][t], b = R.view.perf[m.id][t];
        eq(a.n, b.n, `${cp.key}/${m.id}/${t} : n`);
        eq(a.tier, b.tier, `${cp.key}/${m.id}/${t} : recul`);
        near(a.medAbsMin, b.medAbsMin, 1e-9, `${cp.key}/${m.id}/${t} : erreur médiane`);
        near(a.p80AbsMin, b.p80AbsMin, 1e-9, `${cp.key}/${m.id}/${t} : P80`);
        eq(cp.view.byTarget[m.id][t].status, R.view.byTarget[m.id][t].status, `${cp.key}/${m.id}/${t} : statut`);
        if (m.id === CH) continue;
        const pa = cp.view.paired[m.id][t], pb = R.view.paired[m.id][t];
        eq(pa.pairedN, pb.pairedN, `${cp.key}/${m.id}/${t} : n apparié`);
        near(pa.medianGainMin, pb.medianGainMin, 1e-9, `${cp.key}/${m.id}/${t} : gain médian`);
        eq(pa.freezeAt, pb.freezeAt, `${cp.key}/${m.id}/${t} : même date de gel`);
      }
    }
  });

  test('une vue passée ne peut pas contenir plus de cas qu’une vue postérieure', () => {
    const passés = L.checkpoints.filter(c => c.view && c.week != null);
    ok(passés.length >= 2, `checkpoints passés (${passés.length})`);
    for (let i = 1; i < passés.length; i++) {
      ok(passés[i].dateMs > passés[i - 1].dateMs, `${passés[i].key} après ${passés[i - 1].key}`);
      ok(passés[i].view.casesN >= passés[i - 1].view.casesN,
        `${passés[i].key} ≥ ${passés[i - 1].key} en nombre de cas`);
    }
    ok(L.view.casesN >= passés[passés.length - 1].view.casesN, 'Aujourd’hui ≥ dernier checkpoint');
    eq(L.checkpoints[0].view, L.view, 'la vue « Aujourd’hui » est la vue courante, pas un recalcul');
  });

  suite('14. Laboratoire — export LLM-ready (§3.14)');

  const X = Stats.labExport(L);

  test('schéma complet et auto-descriptif', () => {
    eq(X.schemaVersion, Stats.LAB_SCHEMA_VERSION, 'version de schéma');
    for (const k of ['generatedAt', 'export', 'context', 'conventions', 'models', 'currentPredictions',
      'performance', 'pairwiseComparisonsVsChampion', 'weeklyEvolution', 'checkpoints',
      'experiments', 'cases', 'analysisGuide']) {
      ok(X[k] !== undefined, `clé ${k}`);
    }
    eq(X.conventions.pairedGain, 'absError(M0) - absError(Mx); positive means challenger is better', 'convention du gain');
    eq(X.conventions.signedError, 'actual - predicted; positive means actual happened later', 'convention du signe');
    ok(/never automatic/.test(X.conventions.promotion), 'promotion jamais automatique');
    ok(/not prediction quality/.test(X.conventions.maturityBadge), 'le recul n’est pas une précision');
    ok(/only data available before the case/.test(X.conventions.walkForward), 'walk-forward expliqué');
    eq(X.analysisGuide.length, 7, 'consignes de lecture');
    ok(X.analysisGuide.some(s => /paired cases/.test(s)), 'comparer seulement sur les cas appariés');
  });

  test('dé-identification : sommeil seulement, âge en jours, aucune date de naissance', () => {
    const txt = JSON.stringify(X);
    const p2 = n => String(n).padStart(2, '0');
    eq(X.context.subjectId, 'baby-1', 'identifiant neutre');
    eq(X.export.privacyMode, 'sleep-only-deidentified', 'mode de confidentialité');
    ok(X.context.ageDaysAtExport > 100, `âge en jours (${X.context.ageDaysAtExport})`);
    eq(X.context.birthDate, undefined, 'aucune date de naissance');
    ok(!txt.includes(`${BIRTH.getFullYear()}-${p2(BIRTH.getMonth() + 1)}-${p2(BIRTH.getDate())}`),
      'le jour de naissance n’apparaît nulle part');
    ok(!/1970-01-01/.test(txt), 'aucune date sentinelle');
    for (const mot of ['tetee', 'biberon', 'couche', 'temperature', 'medicament', 'bain', 'appris']) {
      ok(!new RegExp(mot, 'i').test(txt), `aucune trace du domaine ${mot}`);
    }
  });

  test('les métriques exportées sont cohérentes avec la vue', () => {
    const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
    eq(X.models.length, Stats.LAB_MODELS.length, 'tous les modèles décrits');
    X.models.forEach(m => {
      eq(m.status, L.view.status[m.id], `${m.id} : statut`);
      ok(m.pairedN >= 0, `${m.id} : pairedN`);
      if (m.id === 'M8') ok(m.blocked, 'M8 exporte sa raison de non-instanciation');
    });
    eq(X.models.filter(m => m.status === 'active').length, 1, 'un seul modèle actif (le champion)');
    ok(X.pairwiseComparisonsVsChampion.length >= 5, `comparaisons appariées (${X.pairwiseComparisonsVsChampion.length})`);
    X.pairwiseComparisonsVsChampion.forEach(p => {
      const src = L.view.paired[p.challengerId][p.target];
      eq(p.championId, CH, 'référence');
      eq(p.challengerWins + p.ties + p.challengerLosses, p.pairedN, `${p.challengerId}/${p.target} : décompte`);
      eq(p.pairedN, src.pairedN, `${p.challengerId}/${p.target} : n apparié`);
      eq(p.medianGainMin, r1(src.medianGainMin), `${p.challengerId}/${p.target} : gain arrondi à la dixième`);
      eq(p.challengerMedianSignedBiasMin, r1(src.challengerMedSignedMin), `${p.challengerId}/${p.target} : biais`);
    });
    X.performance.forEach(p => {
      eq(p.window, 'recent40', 'fenêtre des métriques annoncée');
      eq(p.n, L.view.perf[p.modelId][p.target].recentN, `${p.modelId}/${p.target} : n de la fenêtre`);
      eq(p.totalN, L.view.perf[p.modelId][p.target].n, `${p.modelId}/${p.target} : n total`);
    });
    eq(X.cases.length, L.cases.length, 'tous les cas exportés');
    const c = X.cases[0];
    for (const k of ['caseId', 'target', 'babyAgeDays', 'localDateTime', 'features', 'actual', 'predictions']) {
      ok(c[k] !== undefined, `cas : clé ${k}`);
    }
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(c.actual), 'horodatage local avec décalage');
    eq(X.weeklyEvolution.length, L.weekly.length, 'évolution hebdo exportée');
    ok(X.checkpoints.every(cp => cp.checkpoint !== 'now'), '« Aujourd’hui » n’est pas un checkpoint exporté');
    X.checkpoints.forEach(cp => {
      eq(cp.humanDecision, null, 'aucune décision inventée');
      ok(cp.focus && cp.question, `${cp.checkpoint} : focus et question`);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(cp.date), `${cp.checkpoint} : date`);
      eq(cp.pending, L.checkpoints.find(x => x.key === cp.checkpoint).future, `${cp.checkpoint} : à venir ou non`);
    });
    X.experiments.forEach(e => {
      eq(e.decision, null, 'aucune décision inventée');
      ok(/^M\d+-v\d+-(onset|wake|remaining)$/.test(e.experimentId), `id d’expérience ${e.experimentId}`);
      ok(e.exploration && e.exploration.pairedN > 0, `${e.experimentId} : bloc exploratoire`);
    });
  });

  suite('15. Laboratoire — briques numériques');

  test('_quantileSorted et _quantile donnent la même chose (une seule passe de tri)', () => {
    const séries = [[5], [1, 2], [4, 1, 3, 2], [7, 7, 7], [1, 2, 3, 4, 5, 6, 7, 8, 9]];
    for (const s of séries) {
      const trié = s.slice().sort((a, b) => a - b);
      for (const p of [0, 0.25, 0.5, 0.75, 0.8, 1]) {
        near(Stats._quantileSorted(trié, p), Stats._quantile(s, p), 1e-12, `P${p * 100} de [${s}]`);
      }
    }
    eq(Stats._quantileSorted([], 0.5), null, 'série vide → null');
    eq(Stats._quantileSorted([3], 0.8), 3, 'un seul échantillon');
  });

  test('_lowerBound trouve le premier index dont atMs ≥ t', () => {
    const s = [10, 20, 20, 30].map(v => ({ atMs: v }));
    eq(Stats._lowerBound(s, 5), 0, 'avant tout');
    eq(Stats._lowerBound(s, 10), 0, 'sur la première valeur');
    eq(Stats._lowerBound(s, 15), 1, 'entre deux');
    eq(Stats._lowerBound(s, 20), 1, 'première des valeurs égales');
    eq(Stats._lowerBound(s, 31), 4, 'après tout');
    eq(Stats._lowerBound([], 1), 0, 'série vide');
  });

  test('_weightedMedian : médiane ordinaire à poids égaux, tirée par les poids sinon', () => {
    const p = v => v.map(x => ({ v: x, w: 1 }));
    eq(Stats._weightedMedian(p([1, 2, 3])), 2, 'poids égaux, impair');
    eq(Stats._weightedMedian(p([1, 2, 3, 4])), 2.5, 'poids égaux, pair');
    eq(Stats._weightedMedian([{ v: 10, w: 100 }, { v: 200, w: 1 }]), 10, 'le poids dominant gagne');
    eq(Stats._weightedMedian([{ v: 200, w: 1 }, { v: 10, w: 100 }]), 10, 'indépendant de l’ordre d’entrée');
    eq(Stats._weightedMedian([]), null, 'aucun échantillon');
    eq(Stats._weightedMedian([{ v: 5, w: 0 }]), null, 'poids nul ignoré');
  });

  test('tranches horaires et jour/nuit : bornes exactes', () => {
    deepEq([0, 5.99, 6, 11.99, 12, 17.99, 18, 23.99].map(h => Stats._labSlot(h)),
      ['nuit', 'nuit', 'matin', 'matin', 'aprem', 'aprem', 'soir', 'soir'], 'tranches horaires');
    eq(Stats._labSlot(null), null, 'heure inconnue');
    deepEq([6.99, 7, 19.99, 20].map(h => Stats._labIsNight(h)), [true, false, false, true], 'nuit = 20h → 7h');
    eq(Stats._labIsNight(null), null, 'heure inconnue');
  });

  test('_labKnn ne fabrique rien quand la feature manque ou que la fenêtre est courte', () => {
    const win = Array.from({ length: 10 }, (_, i) => ({ min: 100 + i, atMs: i }));
    const featMap = new Map(win.map((s, i) => [s, { prevSleepMin: i * 10 }]));
    const ctx = { features: { prevSleepMin: 45 }, featMap };
    // Voisins de 45 : 40, 50, 30, 60, 20 → durées 104, 105, 103, 106, 102 → médiane 104
    eq(Stats._labKnn(ctx, win, 'prevSleepMin'), 104, 'médiane des 5 plus proches voisins');
    eq(Stats._labKnn({ features: {}, featMap }, win, 'prevSleepMin'), null, 'feature du cas inconnue → null');
    eq(Stats._labKnn(ctx, win.slice(0, Stats.LAB_KNN_MIN_N - 1), 'prevSleepMin'), null, 'fenêtre trop courte → null');
    eq(Stats._labKnn(ctx, win, 'prevWakeMin'), null, 'feature absente des échantillons → null');
  });

  test('les compteurs du résumé d’export sont vrais', () => {
    eq(L.counts.models, Stats.LAB_MODELS.length, 'modèles');
    eq(L.counts.instantiated, Stats.LAB_MODELS.filter(m => m.predict).length, 'modèles instanciés');
    eq(L.counts.cases, L.cases.length, 'cas');
    ok(L.counts.weekFrom <= L.counts.weekTo, 'plage de semaines');
    eq(L.counts.weekFrom, Math.min(...L.weekly.map(w => w.ageWeek)), 'première semaine vue');
    eq(L.counts.weekTo, Math.max(...L.weekly.map(w => w.ageWeek)), 'dernière semaine vue');
  });
};
