/* =========================================================
   Tests de stats.js — la couche de calcul (source unique des KPI).
   Sections calquées sur SPECS-stats.md :
     1. Épisodes de sommeil & découpe à minuit  (§0 règle 2, §C)
     2. Agrégats par jour                       (§A→§E)
     3. Moyennes & ratios de période            (§0 règles 3-5)
     4. Qualité des données                     (§0 règle 6)
     5. Frontières de jour & heure d'été
     6. Propriétés / invariants (200 scénarios pseudo-aléatoires)
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, near, deepEq, ok, Stats }) => {

  /* ---------- Fixtures ---------- */
  // Horodatage LOCAL (le fuseau est forcé à Europe/Paris par run.js)
  const iso = (y, m, d, h, mi, s = 0) => new Date(y, m - 1, d, h, mi, s).toISOString();
  let seq = 0;
  const ev = (action, ts, data = {}) => ({ id: `${action}-${++seq}`, action, ts, data });
  const slp = (ts, end = null) => ev('sommeil', ts, { end });
  const NOW = new Date(2026, 7, 13, 12, 0);              // 13 août 2026, 12:00
  const NOWMS = NOW.getTime();
  const OPTS = {
    periodDays: 7, now: NOW,
    domainStart: { repas: new Date(2026, 7, 6), couche: new Date(2026, 7, 11), sommeil: new Date(2026, 7, 11) },
    firstCompleteDay: new Date(2026, 7, 7),
  };
  const day = (res, key) => res.days.find(d => d.key === key);
  const pick = (o, keys) => keys.reduce((a, k) => (a[k] = o[k], a), {});
  const mins = segs => segs.map(g => g.min);

  // Journée réaliste du 12 août + les nuits qui l'encadrent.
  const scenario = () => [
    slp(iso(2026, 8, 11, 22, 30), iso(2026, 8, 12, 2, 0)),   // nuit à cheval : 90 min le 11, 120 le 12
    slp(iso(2026, 8, 12, 9, 15), iso(2026, 8, 12, 10, 5)),   // sieste 50 min
    slp(iso(2026, 8, 12, 13, 0), iso(2026, 8, 12, 14, 20)),  // sieste 80 min
    slp(iso(2026, 8, 12, 23, 50), iso(2026, 8, 13, 7, 5)),   // nuit à cheval : 10 min le 12, 425 le 13
    ev('tetee', iso(2026, 8, 12, 8, 0), { side: 'gauche', duration: 15 }),
    ev('tetee', iso(2026, 8, 12, 11, 30), { side: 'les deux', duration: 20 }),
    ev('tetee', iso(2026, 8, 12, 16, 0), { duration: 10 }),   // sans côté → qualité
    ev('biberon', iso(2026, 8, 12, 18, 0), { ml: 120 }),
    ev('biberon', iso(2026, 8, 12, 21, 0), { ml: 90 }),
    ev('couche', iso(2026, 8, 12, 9, 0), { type: 'mixte' }),
    ev('couche', iso(2026, 8, 12, 17, 0), { type: 'pipi' }),
    ev('couche', iso(2026, 8, 12, 20, 0), {}),                // sans contenu → qualité
    ev('temperature', iso(2026, 8, 12, 20, 30), { temp: 37.4 }),
    ev('temperature', iso(2026, 8, 12, 22, 0), { temp: 38.2 }),
    ev('bain', iso(2026, 8, 12, 19, 0)),
    ev('medicament', iso(2026, 8, 12, 21, 30), { name: 'Doliprane' }),
    { ...ev('tetee', iso(2026, 8, 12, 10, 0), { side: 'droite' }), deleted: true }, // tombstone
    ev('appris', iso(2026, 8, 12, 12, 0), { text: 'sourit' }),   // hors stats
    ev('vitamined', iso(2026, 8, 12, 12, 5)),                    // checklist : ne "suit" pas un jour
  ];

  /* =====================================================
     1. Épisodes de sommeil & découpe à minuit
     ===================================================== */
  suite('1. Sommeil — résolution et découpe à minuit');

  test('épisode simple dans la journée', () => {
    const s = Stats.sleepSegments(slp(iso(2026, 8, 12, 13, 0), iso(2026, 8, 12, 14, 20)), NOWMS);
    eq(s.length, 1, 'un seul segment');
    eq(s[0].min, 80, 'minutes');
    eq(s[0].totalMin, 80, 'totalMin');
    eq(s[0].contPrev, false); eq(s[0].contNext, false); eq(s[0].ongoing, false);
  });

  test('22h30 → 02h00 : 1h30 le 1er jour, 2h le 2e (cas de référence)', () => {
    const s = Stats.sleepSegments(slp(iso(2026, 8, 12, 22, 30), iso(2026, 8, 13, 2, 0)), NOWMS);
    deepEq(mins(s), [90, 120], 'minutes par jour');
    eq(s[0].totalMin, 210, 'durée de la nuit entière');
    eq(s[1].totalMin, 210);
    deepEq([s[0].contPrev, s[0].contNext], [false, true], 'segment 1 tronqué après');
    deepEq([s[1].contPrev, s[1].contNext], [true, false], 'segment 2 tronqué avant');
    eq(new Date(s[0].dayMs).getDate(), 12); eq(new Date(s[1].dayMs).getDate(), 13);
  });

  test('épisode sur 3 jours civils', () => {
    const s = Stats.sleepSegments(slp(iso(2026, 8, 11, 23, 0), iso(2026, 8, 13, 1, 0)), NOWMS);
    deepEq(mins(s), [60, 1440, 60]);
    eq(s[0].totalMin, 1560);
  });

  test('dodo en cours : compté jusqu’à maintenant, seul le dernier segment est ongoing', () => {
    const s = Stats.sleepSegments(slp(iso(2026, 8, 13, 10, 30), null), NOWMS);
    deepEq(mins(s), [90]);
    eq(s[0].ongoing, true);
    const s2 = Stats.sleepSegments(slp(iso(2026, 8, 12, 22, 0), null), NOWMS);
    deepEq(mins(s2), [120, 720], 'nuit en cours découpée');
    deepEq(s2.map(g => g.ongoing), [false, true]);
  });

  test('seuil des 16 h d’un dodo en cours : borne exacte', () => {
    const at = h => Stats.sleepSegments(slp(new Date(NOWMS - h * 3600000).toISOString(), null), NOWMS);
    ok(at(15.9).length > 0, '15,9 h → compté');
    eq(at(16).length, 0, '16 h → ignoré');
    eq(at(16.1).length, 0, '16,1 h → ignoré');
  });

  test('épisode clos de ≥ 16 h : compté (décision produit) mais marqué aberrant', () => {
    const e = slp(iso(2026, 8, 11, 20, 0), iso(2026, 8, 13, 2, 0));    // 30 h
    deepEq(mins(Stats.sleepSegments(e, NOWMS)), [240, 1440, 120], 'toujours compté');
    eq(Stats.sleepEpisodes([e], { nowMs: NOWMS })[0].aberrant, true);
    const court = slp(iso(2026, 8, 12, 0, 0), iso(2026, 8, 12, 10, 0));
    eq(Stats.sleepEpisodes([court], { nowMs: NOWMS })[0].aberrant, false, '10 h → plausible');
  });

  test('épisodes invalides → aucun segment', () => {
    eq(Stats.sleepSegments(slp(iso(2026, 8, 12, 14, 0), iso(2026, 8, 12, 13, 0)), NOWMS).length, 0, 'fin < début');
    eq(Stats.sleepSegments(slp(iso(2026, 8, 12, 14, 0), iso(2026, 8, 12, 14, 0)), NOWMS).length, 0, 'fin = début');
    eq(Stats.sleepSegments(slp(iso(2026, 8, 12, 14, 0), 'nawak'), NOWMS).length, 0, 'fin illisible');
    eq(Stats.sleepSegments({ id: 'a', action: 'sommeil', ts: 'pas-une-date', data: { end: null } }, NOWMS).length, 0, 'début illisible');
    eq(Stats.sleepSegments({ id: 'b', action: 'sommeil', ts: iso(2026, 8, 12, 14, 0) }, NOWMS).length, 0, 'data absente → traité comme en cours');
    eq(Stats.sleepSegments(ev('tetee', iso(2026, 8, 12, 14, 0)), NOWMS).length, 0, 'autre action');
  });

  test('invariant : Σ des minutes des segments = totalMin (même avec des secondes)', () => {
    const cas = [
      slp(iso(2026, 8, 12, 22, 30, 20), iso(2026, 8, 13, 2, 0, 40)),
      slp(iso(2026, 8, 12, 23, 59, 50), iso(2026, 8, 13, 0, 0, 30)),
      slp(iso(2026, 8, 11, 20, 15, 7), iso(2026, 8, 13, 6, 42, 51)),
    ];
    cas.forEach((e, i) => {
      const s = Stats.sleepSegments(e, NOWMS);
      eq(s.reduce((t, g) => t + g.min, 0), s[0].totalMin, `cas ${i}`);
    });
  });

  test('dodo de 40 s : arrondi à 1 min (et compté comme 1 dodo)', () => {
    const s = Stats.sleepSegments(slp(iso(2026, 8, 12, 14, 0, 0), iso(2026, 8, 12, 14, 0, 40)), NOWMS);
    deepEq(mins(s), [1]);
  });

  test('sleepEpisodes : tri croissant, tombstones exclus, chevauchements marqués', () => {
    const evs = [
      slp(iso(2026, 8, 12, 17, 0), iso(2026, 8, 12, 18, 0)),
      slp(iso(2026, 8, 12, 13, 0), iso(2026, 8, 12, 16, 0)),
      { ...slp(iso(2026, 8, 12, 9, 0), iso(2026, 8, 12, 10, 0)), deleted: true },
      slp(iso(2026, 8, 12, 14, 0), iso(2026, 8, 12, 15, 0)),   // englobé par 13h→16h
    ];
    const eps = Stats.sleepEpisodes(evs, { nowMs: NOWMS });
    deepEq(eps.map(e => e.min), [180, 60, 60], 'triés par début, supprimé exclu');
    deepEq(eps.map(e => e.overlapsPrev), [false, true, false], 'seul l’épisode englobé chevauche');
    eq(eps[1].startMs < eps[0].endMs, true);
  });

  test('sleepEpisodes : un long épisode englobant est détecté même après un court', () => {
    const eps = Stats.sleepEpisodes([
      slp(iso(2026, 8, 12, 10, 0), iso(2026, 8, 12, 18, 0)),   // long
      slp(iso(2026, 8, 12, 11, 0), iso(2026, 8, 12, 11, 30)),  // court, dedans
      slp(iso(2026, 8, 12, 12, 0), iso(2026, 8, 12, 12, 30)),  // court, dedans (après le court précédent)
    ], { nowMs: NOWMS });
    deepEq(eps.map(e => e.overlapsPrev), [false, true, true], 'comparé à la fin la plus tardive vue');
  });

  /* =====================================================
     2. Agrégats par jour
     ===================================================== */
  suite('2. Agrégats par jour');

  test('journée réaliste du 12 août : toutes les valeurs', () => {
    const d = day(Stats.compute(scenario(), OPTS), '2026-7-12');
    deepEq(pick(d, ['tetees', 'biberons', 'repas', 'volumeMl', 'teteeDurMin']),
      { tetees: 3, biberons: 2, repas: 5, volumeMl: 210, teteeDurMin: 45 }, 'repas');
    deepEq(pick(d, ['pipis', 'cacas', 'couches']), { pipis: 2, cacas: 1, couches: 3 }, 'couches');
    deepEq(pick(d, ['sleepMin', 'naps', 'longestSleepMin']),
      { sleepMin: 260, naps: 4, longestSleepMin: 210 }, 'sommeil : 120+50+80+10, 4 dodos, nuit entière de 210');
    eq(d.tempMax, 38.2, 'température max');
    near(d.bottleShare, 0.4, 1e-9, 'part du biberon');
    eq(d.longestFeedGapMin, 270, 'plus long intervalle entre repas du jour');
    deepEq(pick(d, ['tracked', 'complete', 'partial']), { tracked: true, complete: true, partial: false });
  });

  test('« plus long sommeil » va au jour MAJORITAIRE (pas au jour de début)', () => {
    const r = Stats.compute(scenario(), OPTS);
    eq(day(r, '2026-7-11').longestSleepMin, 0, '11 août : 90 min de la nuit, mais la nuit "appartient" au 12');
    eq(day(r, '2026-7-12').longestSleepMin, 210);
    eq(day(r, '2026-7-13').longestSleepMin, 435, 'la nuit 23h50 → 07h05 est majoritaire le 13');
    // À égalité de minutes, c'est le jour de début qui garde l'épisode.
    const r2 = Stats.compute([slp(iso(2026, 8, 12, 22, 0), iso(2026, 8, 13, 2, 0))], OPTS);
    eq(day(r2, '2026-7-12').longestSleepMin, 240, 'égalité 120/120 → jour de début');
    eq(day(r2, '2026-7-13').longestSleepMin, 0);
  });

  test('longestSleepMin peut dépasser sleepMin du jour (exception assumée)', () => {
    const d = day(Stats.compute([slp(iso(2026, 8, 12, 20, 0), iso(2026, 8, 13, 4, 0))], OPTS), '2026-7-12');
    eq(d.sleepMin, 240); eq(d.longestSleepMin, 480);
  });

  test('un jour dont le seul contenu est la fin d’une nuit est "suivi"', () => {
    const d = day(Stats.compute([slp(iso(2026, 8, 11, 22, 30), iso(2026, 8, 12, 2, 0))], OPTS), '2026-7-12');
    deepEq(pick(d, ['sleepMin', 'naps', 'tracked']), { sleepMin: 120, naps: 1, tracked: true });
  });

  test('tombstones, "appris" et checklist ne comptent pas', () => {
    const r = Stats.compute(scenario(), OPTS);
    eq(day(r, '2026-7-12').tetees, 3, 'la tétée supprimée est exclue');
    const seulChecklist = Stats.compute([ev('vitamined', iso(2026, 8, 12, 10, 0)), ev('appris', iso(2026, 8, 12, 11, 0))], OPTS);
    eq(day(seulChecklist, '2026-7-12').tracked, false, 'checklist/appris ne suffisent pas à "suivre" un jour');
  });

  test('événement hors fenêtre ignoré, mais nuit qui déborde DANS la fenêtre comptée', () => {
    const evs = [
      ev('tetee', iso(2026, 8, 5, 10, 0), { side: 'gauche' }),          // avant la fenêtre (7→13)
      slp(iso(2026, 8, 6, 23, 0), iso(2026, 8, 7, 3, 0)),               // démarre avant, déborde le 7
    ];
    const r = Stats.compute(evs, OPTS);
    eq(r.days.reduce((s, d) => s + d.repas, 0), 0, 'la tétée du 5 août n’est pas comptée');
    const d7 = day(r, '2026-7-7');
    deepEq(pick(d7, ['sleepMin', 'naps']), { sleepMin: 180, naps: 1 }, 'seules les minutes du 7 sont comptées');
    eq(d7.longestSleepMin, 240, 'jour majoritaire = le 7 (180 min sur 240) → l’épisode entier y est rattaché');
  });

  test('épisode majoritaire sur un jour hors fenêtre : minutes comptées, "plus long" perdu', () => {
    // 6 août 22h → 7 août 1h : 120 min le 6 (hors fenêtre), 60 min le 7.
    const r = Stats.compute([slp(iso(2026, 8, 6, 22, 0), iso(2026, 8, 7, 1, 0))], OPTS);
    const d7 = day(r, '2026-7-7');
    eq(d7.sleepMin, 60, 'les minutes du 7 comptent');
    eq(d7.longestSleepMin, 0, 'le "plus long" appartient au 6, invisible dans cette fenêtre');
  });

  test('aujourd’hui est partiel, le sommeil en cours va jusqu’à maintenant', () => {
    const r = Stats.compute([...scenario(), slp(iso(2026, 8, 13, 11, 0), null)], OPTS);
    const t = day(r, '2026-7-13');
    eq(t.partial, true); eq(t.complete, false);
    eq(r.today.key, '2026-7-13', 'today = le jour partiel');
    eq(t.sleepMin, 425 + 60, 'nuit (425) + dodo en cours depuis 11h (60)');
    eq(t.naps, 2);
  });

  test('champs manquants ou illisibles : l’événement compte, la sous-métrique non', () => {
    const evs = [
      ev('biberon', iso(2026, 8, 12, 10, 0), { ml: 'abc' }),
      ev('biberon', iso(2026, 8, 12, 11, 0), {}),
      ev('biberon', iso(2026, 8, 12, 12, 0), { ml: 100 }),
      ev('tetee', iso(2026, 8, 12, 13, 0), { side: 'gauche' }),          // sans durée
      ev('temperature', iso(2026, 8, 12, 14, 0), {}),
      { id: 'nots', action: 'tetee', ts: 'pas-une-date', data: { side: 'droite' } },
    ];
    const d = day(Stats.compute(evs, OPTS), '2026-7-12');
    deepEq(pick(d, ['biberons', 'volumeMl', 'tetees', 'teteeDurMin', 'repas']),
      { biberons: 3, volumeMl: 100, tetees: 1, teteeDurMin: 0, repas: 4 }, 'ts illisible exclu, ml illisible ignoré');
    eq(d.tempMax, null, 'température sans valeur → pas de max');
  });

  test('aucun événement : jours à zéro, non suivis, aucune moyenne', () => {
    const r = Stats.compute([], OPTS);
    eq(r.days.length, 7);
    eq(r.days.every(d => !d.tracked && d.sleepMin === 0 && d.repas === 0), true);
    eq(r.averages.trackedDays, 0);
    eq(r.averages.repas, null, 'pas de moyenne sans jour suivi');
    eq(r.period.bottleShare, null);
  });

  /* =====================================================
     3. Moyennes & ratios de période
     ===================================================== */
  suite('3. Moyennes /jour & ratios de période');

  test('dénominateurs : jours suivis, complets, et domaine fiable', () => {
    const av = Stats.compute(scenario(), OPTS).averages;
    // Fenêtre 7→13 août : 7-10 non suivis, 11 et 12 suivis+complets, 13 partiel.
    eq(av.trackedDays, 2, 'jours moyennables');
    eq(av.trackedDaysRepas, 2); eq(av.trackedDaysCouche, 2); eq(av.trackedDaysSommeil, 2);
    near(av.sleepMin, (90 + 260) / 2, 1e-9, 'sommeil moyen');
    near(av.naps, (1 + 4) / 2, 1e-9);
    near(av.longestSleepMin, (0 + 210) / 2, 1e-9);
    // Le 11 août est "suivi" (fin de nuit) sans aucun repas : c'est un vrai zéro,
    // pas une absence de donnée → il entre au dénominateur des repas.
    near(av.repas, 5 / 2, 1e-9, 'repas moyens');
    near(av.volumeMl, 210 / 2, 1e-9);
    near(av.couches, 3 / 2, 1e-9);
  });

  test('domaine antérieur à sa date de fiabilité → exclu (jamais un faux zéro)', () => {
    const evs = [
      ev('tetee', iso(2026, 8, 9, 8, 0), { side: 'gauche' }),
      ev('tetee', iso(2026, 8, 12, 8, 0), { side: 'gauche' }),
      ev('couche', iso(2026, 8, 12, 9, 0), { type: 'pipi' }),
    ];
    const r = Stats.compute(evs, OPTS);   // couches fiables à partir du 11 août
    eq(day(r, '2026-7-9').dataCouche, false, '9 août : pas de donnée couche');
    eq(day(r, '2026-7-9').dataRepas, true);
    const av = r.averages;
    eq(av.trackedDaysRepas, 2, '9 et 12 août');
    eq(av.trackedDaysCouche, 1, 'seul le 12 août compte pour les couches');
    near(av.couches, 1, 1e-9, 'pas de division par le 9 août');
  });

  test('jour de naissance partiel (avant firstCompleteDay) exclu des moyennes', () => {
    const evs = [ev('tetee', iso(2026, 8, 6, 8, 0), { side: 'gauche' }), ev('tetee', iso(2026, 8, 12, 8, 0), { side: 'gauche' })];
    const r = Stats.compute(evs, { ...OPTS, periodDays: 10 });
    eq(day(r, '2026-7-6').complete, false, '6 août = jour de naissance, incomplet');
    eq(r.averages.trackedDaysRepas, 1, 'seul le 12 août est moyennable');
  });

  test('aujourd’hui : exclu des moyennes, inclus dans les ratios de période', () => {
    const evs = [
      ev('biberon', iso(2026, 8, 12, 10, 0), { ml: 100 }),
      ev('tetee', iso(2026, 8, 12, 12, 0), { side: 'gauche' }),
      ev('biberon', iso(2026, 8, 13, 10, 0), { ml: 100 }),      // aujourd'hui
      ev('temperature', iso(2026, 8, 13, 11, 0), { temp: 38.4 }), // fièvre du jour
    ];
    const r = Stats.compute(evs, OPTS);
    near(r.averages.repas, 2, 1e-9, 'moyenne sur le 12 seul');
    near(r.period.bottleShare, 2 / 3, 1e-9, 'ratio de période : le biberon du jour compte');
    eq(r.period.tempMax, 38.4, 'la fièvre du jour n’est pas masquée');
    eq(r.period.tempAlert, true, 'seuil 38,0 °C');
  });

  test('équilibre des côtés : « les deux » compte 0,5 de chaque', () => {
    const p = Stats.compute([
      ev('tetee', iso(2026, 8, 12, 8, 0), { side: 'gauche' }),
      ev('tetee', iso(2026, 8, 12, 10, 0), { side: 'les deux' }),
    ], OPTS).period;
    eq(p.sideLeftPct, 75); eq(p.sideRightPct, 25);
  });

  test('intervalles entre repas et entre cacas (y compris à cheval sur minuit)', () => {
    const p = Stats.compute([
      ev('tetee', iso(2026, 8, 11, 23, 0), { side: 'gauche' }),
      ev('tetee', iso(2026, 8, 12, 2, 0), { side: 'droite' }),   // 180 min plus tard, autre jour
      ev('tetee', iso(2026, 8, 12, 4, 0), { side: 'gauche' }),   // 120 min
      ev('couche', iso(2026, 8, 11, 20, 0), { type: 'caca' }),
      ev('couche', iso(2026, 8, 12, 8, 0), { type: 'mixte' }),   // 720 min
    ], OPTS).period;
    eq(p.avgFeedGapMin, 150, 'moyenne (180 + 120) / 2');
    eq(p.longestFeedGapMin, 180);
    eq(p.avgPoopGapMin, 720, 'intervalle entre 2 cacas, mixte inclus');
  });

  test('période : bains, médicaments (du + récent au + ancien), un seul repas → pas d’intervalle', () => {
    const p = Stats.compute([
      ev('bain', iso(2026, 8, 12, 19, 0)),
      ev('bain', iso(2026, 8, 13, 19, 0)),
      ev('medicament', iso(2026, 8, 11, 9, 0), { name: 'Vitamine' }),
      ev('medicament', iso(2026, 8, 12, 21, 0), { name: 'Doliprane' }),
      ev('medicament', iso(2026, 8, 12, 22, 0), {}),
      ev('tetee', iso(2026, 8, 12, 8, 0), { side: 'gauche' }),
    ], OPTS).period;
    eq(p.bains, 2);
    deepEq(p.meds.map(m => m.name), ['Médicament', 'Doliprane', 'Vitamine'], 'tri récent → ancien, libellé par défaut');
    eq(p.avgFeedGapMin, null, 'un seul repas → pas d’intervalle');
  });

  /* =====================================================
     4. Qualité des données
     ===================================================== */
  suite('4. Qualité des données');

  test('les 5 anomalies historiques', () => {
    const noSide = ev('tetee', iso(2026, 8, 12, 16, 0), { duration: 10 });
    const noType = ev('couche', iso(2026, 8, 12, 20, 0), {});
    const open = slp(iso(2026, 8, 12, 10, 0), null);                          // > 16 h à 13 août 12h
    const neg = slp(iso(2026, 8, 12, 14, 0), iso(2026, 8, 12, 13, 0));
    const hot = ev('temperature', iso(2026, 8, 12, 15, 0), { temp: 43.2 });
    const cold = ev('temperature', iso(2026, 8, 12, 15, 30), { temp: 33.9 });
    const q = Stats.compute([noSide, noType, open, neg, hot, cold], OPTS).quality;
    deepEq(q.teteesSansCote, [noSide.id]);
    deepEq(q.couchesSansType, [noType.id]);
    deepEq(q.dodosNonFermes, [open.id]);
    deepEq(q.dureesNegatives, [neg.id]);
    deepEq(q.tempHorsPlage, [cold.id, hot.id], 'du + récent au + ancien');
  });

  test('listes d’anomalies triées du + récent au + ancien (ordre stable)', () => {
    const a = ev('couche', iso(2026, 8, 11, 8, 0), {});
    const b = ev('couche', iso(2026, 8, 12, 9, 0), {});
    const c = ev('couche', iso(2026, 8, 13, 10, 0), {});
    const attendu = [c.id, b.id, a.id];
    deepEq(Stats.compute([a, b, c], OPTS).quality.couchesSansType, attendu);
    deepEq(Stats.compute([c, a, b], OPTS).quality.couchesSansType, attendu, 'quel que soit l’ordre d’entrée');
  });

  test('température aux bornes de la plage plausible : 34 et 42 acceptées', () => {
    const q = Stats.compute([
      ev('temperature', iso(2026, 8, 12, 10, 0), { temp: 34 }),
      ev('temperature', iso(2026, 8, 12, 11, 0), { temp: 42 }),
    ], OPTS).quality;
    deepEq(q.tempHorsPlage, []);
  });

  test('durée improbable (≥ 16 h) : signalée, et toujours comptée', () => {
    const e = slp(iso(2026, 8, 11, 20, 0), iso(2026, 8, 13, 2, 0));   // 30 h
    const r = Stats.compute([e], OPTS);
    deepEq(r.quality.dureesAberrantes, [e.id]);
    eq(day(r, '2026-7-12').sleepMin, 1440, 'compté tel quel (reflet du journal)');
    eq(day(r, '2026-7-12').longestSleepMin, 1800);
  });

  test('dodos qui se chevauchent : le plus tardif est signalé, minutes additionnées', () => {
    const a = slp(iso(2026, 8, 12, 13, 0), iso(2026, 8, 12, 15, 0));
    const b = slp(iso(2026, 8, 12, 13, 5), iso(2026, 8, 12, 15, 10));
    const r = Stats.compute([a, b], OPTS);
    deepEq(r.quality.dodosChevauchants, [b.id], 'seul le doublon est listé');
    eq(day(r, '2026-7-12').sleepMin, 120 + 125, 'pas de fusion automatique');
    eq(day(r, '2026-7-12').naps, 2);
  });

  test('dodos qui se touchent (fin = début) : pas un chevauchement', () => {
    const r = Stats.compute([
      slp(iso(2026, 8, 12, 13, 0), iso(2026, 8, 12, 14, 0)),
      slp(iso(2026, 8, 12, 14, 0), iso(2026, 8, 12, 15, 0)),
    ], OPTS);
    deepEq(r.quality.dodosChevauchants, []);
  });

  test('anomalies limitées à la fenêtre affichée (tous domaines)', () => {
    const evs = [
      slp(iso(2026, 8, 1, 14, 0), null),                                  // dodo oublié, hors fenêtre
      slp(iso(2026, 8, 2, 14, 0), iso(2026, 8, 2, 13, 0)),                // durée négative, hors fenêtre
      slp(iso(2026, 8, 1, 20, 0), iso(2026, 8, 3, 2, 0)),                 // 30 h, hors fenêtre
      ev('couche', iso(2026, 8, 1, 15, 0), {}),                           // hors fenêtre
      ev('tetee', iso(2026, 8, 12, 16, 0), { duration: 10 }),             // DANS la fenêtre
    ];
    const q7 = Stats.compute(evs, OPTS).quality;
    deepEq([q7.dodosNonFermes, q7.dureesNegatives, q7.dureesAberrantes, q7.couchesSansType.length],
      [[], [], [], 0], 'rien d’antérieur au 7 août ne remonte');
    eq(q7.teteesSansCote.length, 1, 'l’anomalie de la fenêtre remonte bien');
    const q30 = Stats.compute(evs, { ...OPTS, periodDays: 30 }).quality;
    eq(q30.dodosNonFermes.length, 1, 'en 30 j, les anciennes anomalies apparaissent');
    eq(q30.dureesNegatives.length, 1);
    eq(q30.dureesAberrantes.length, 1);
    eq(q30.couchesSansType.length, 1);
  });

  /* =====================================================
     5. Frontières de jour & heure d'été
     ===================================================== */
  suite('5. Frontières de jour & heure d’été (Europe/Paris)');

  test('fuseau de test bien appliqué', () => {
    eq(new Date(2026, 7, 12, 12, 0).toISOString(), '2026-08-12T10:00:00.000Z', 'UTC+2 en été');
    eq(new Date(2026, 0, 12, 12, 0).toISOString(), '2026-01-12T11:00:00.000Z', 'UTC+1 en hiver');
  });

  test('daysWindow : N jours civils, tous à minuit, du + ancien au + récent', () => {
    const w = Stats.daysWindow(new Date(2026, 9, 28, 15, 30), 7);   // à cheval sur le 25 oct (jour de 25 h)
    eq(w.length, 7);
    eq(w.every(d => d.getHours() === 0 && d.getMinutes() === 0), true, 'tous à minuit local');
    eq(w[0].getDate(), 22); eq(w[6].getDate(), 28);
    eq(Stats.dayKey(w[3]), '2026-9-25');
  });

  test('nuit du passage à l’heure d’hiver (jour de 25 h)', () => {
    // 25 oct 2026 : 3h → 2h. Un "minuit à minuit" fait 25 h de vrai temps.
    deepEq(mins(Stats.sleepSegments(slp(iso(2026, 10, 25, 0, 0), iso(2026, 10, 26, 0, 0)), NOWMS)), [1500]);
    deepEq(mins(Stats.sleepSegments(slp(iso(2026, 10, 24, 22, 30), iso(2026, 10, 25, 2, 0)), NOWMS)), [90, 120]);
  });

  test('nuit du passage à l’heure d’été (jour de 23 h)', () => {
    // 29 mars 2026 : 2h → 3h. De 00h à 04h il ne s'écoule que 3 h.
    deepEq(mins(Stats.sleepSegments(slp(iso(2026, 3, 28, 22, 30), iso(2026, 3, 29, 4, 0)), NOWMS)), [90, 180]);
    deepEq(mins(Stats.sleepSegments(slp(iso(2026, 3, 29, 0, 0), iso(2026, 3, 30, 0, 0)), NOWMS)), [1380]);
  });

  test('agrégat correct autour d’un changement d’heure', () => {
    const r = Stats.compute([slp(iso(2026, 10, 24, 22, 30), iso(2026, 10, 25, 2, 0))],
      { periodDays: 7, now: new Date(2026, 9, 26, 12, 0) });
    eq(day(r, '2026-9-24').sleepMin, 90);
    eq(day(r, '2026-9-25').sleepMin, 120);
    eq(day(r, '2026-9-25').longestSleepMin, 210, 'jour majoritaire');
  });

  test('comptage de jours civils : Math.round obligatoire (règle de l’export /jour)', () => {
    // app.js#exportDailyCSV déduit le nombre de jours d'un écart en ms : avec
    // Math.floor, une semaine contenant un passage à l'heure d'été (= 23 h)
    // perd un jour. Le test documente pourquoi c'est round.
    const nb = (a, b, f) => f((Stats.startOfDay(b) - Stats.startOfDay(a)) / 86400000) + 1;
    eq(nb(new Date(2026, 2, 26), new Date(2026, 3, 2), Math.floor), 7, 'floor : 1 jour perdu');
    eq(nb(new Date(2026, 2, 26), new Date(2026, 3, 2), Math.round), 8, 'round : correct');
    eq(nb(new Date(2026, 9, 22), new Date(2026, 9, 28), Math.round), 7, 'et correct aussi en heure d’hiver');
    eq(nb(new Date(2026, 7, 6), new Date(2026, 7, 13), Math.round), 8, 'cas sans changement d’heure');
  });

  /* =====================================================
     6. Propriétés / invariants
     ===================================================== */
  suite('6. Propriétés (200 scénarios pseudo-aléatoires, graine fixe)');

  // PRNG déterministe (pas de Math.random : un échec doit être reproductible).
  const lcg = seed => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

  function randomScenario(rnd) {
    const evs = [];
    const n = 3 + Math.floor(rnd() * 30);
    for (let i = 0; i < n; i++) {
      const dayOffset = Math.floor(rnd() * 12);                       // 2 → 13 août
      const d = 2 + dayOffset, h = Math.floor(rnd() * 24), mi = Math.floor(rnd() * 60), s = Math.floor(rnd() * 60);
      const start = iso(2026, 8, d, h, mi, s);
      const r = rnd();
      if (r < 0.45) {
        const durMin = Math.floor(rnd() * 700);                       // 0 → 11 h 40
        const end = new Date(new Date(start).getTime() + durMin * 60000).toISOString();
        if (rnd() < 0.08) evs.push(slp(start, null));                 // en cours
        else if (rnd() < 0.05) evs.push(slp(end, start));             // durée négative
        else evs.push(slp(start, end));
      } else if (r < 0.65) evs.push(ev('tetee', start, rnd() < 0.2 ? {} : { side: ['gauche', 'droite', 'les deux'][Math.floor(rnd() * 3)], duration: Math.floor(rnd() * 40) }));
      else if (r < 0.8) evs.push(ev('biberon', start, rnd() < 0.15 ? {} : { ml: Math.floor(rnd() * 200) }));
      else if (r < 0.92) evs.push(ev('couche', start, rnd() < 0.15 ? {} : { type: ['pipi', 'caca', 'mixte'][Math.floor(rnd() * 3)] }));
      else if (r < 0.96) evs.push(ev('temperature', start, { temp: 33 + rnd() * 10 }));
      else evs.push(ev('bain', start));
      if (rnd() < 0.05) evs[evs.length - 1].deleted = true;
      if (rnd() < 0.03) evs[evs.length - 1].ts = 'invalide';
    }
    return evs;
  }

  const nonFinite = (o, p = 'res', out = []) => {
    if (o == null) return out;
    if (typeof o === 'number') { if (!Number.isFinite(o)) out.push(`${p}=${o}`); return out; }
    if (o instanceof Date) { if (isNaN(o)) out.push(`${p}=InvalidDate`); return out; }
    if (typeof o === 'object') for (const k in o) nonFinite(o[k], `${p}.${k}`, out);
    return out;
  };
  const shuffle = (arr, rnd) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // Recalcul INDÉPENDANT des minutes de sommeil d'un jour (autre écriture que
  // _splitAtMidnight : intersection directe épisode × jour).
  const minutesIn = (eps, dayStart) => {
    const dS = dayStart.getTime(), dE = Stats.addDays(dayStart, 1).getTime();
    let min = 0, count = 0;
    for (const ep of eps) {
      const a = Math.max(dS, ep.startMs), b = Math.min(dE, ep.endMs);
      if (b > a) { min += Math.round((b - a) / 60000); count++; }
    }
    return { min, count };
  };

  test('aucune valeur non finie dans la sortie', () => {
    const rnd = lcg(20260813);
    for (let i = 0; i < 200; i++) {
      const evs = randomScenario(rnd);
      const bad = nonFinite(Stats.compute(evs, { ...OPTS, periodDays: [7, 14, 30][i % 3] }));
      if (bad.length) throw new Error(`scénario ${i} : ${bad.join(', ')}`);
    }
  });

  test('minutes et dodos par jour = intersection épisodes × jour (calcul indépendant)', () => {
    const rnd = lcg(777);
    for (let i = 0; i < 200; i++) {
      const evs = randomScenario(rnd);
      const r = Stats.compute(evs, OPTS);
      const eps = Stats.sleepEpisodes(evs, { nowMs: NOWMS });
      for (const d of r.days) {
        const exp = minutesIn(eps, d.date);
        if (d.sleepMin !== exp.min) throw new Error(`scénario ${i}, ${d.key} : sleepMin ${d.sleepMin} ≠ ${exp.min}`);
        if (d.naps !== exp.count) throw new Error(`scénario ${i}, ${d.key} : naps ${d.naps} ≠ ${exp.count}`);
      }
    }
  });

  test('sans chevauchement, un jour ne dépasse jamais 1440 min', () => {
    const rnd = lcg(31415);
    let vus = 0;
    for (let i = 0; i < 200; i++) {
      const evs = randomScenario(rnd);
      const eps = Stats.sleepEpisodes(evs, { nowMs: NOWMS });
      if (eps.some(e => e.overlapsPrev)) continue;   // cas connu : minutes additionnées
      vus++;
      for (const d of Stats.compute(evs, OPTS).days) {
        if (d.sleepMin > 1440) throw new Error(`scénario ${i}, ${d.key} : ${d.sleepMin} min`);
      }
    }
    ok(vus > 10, `assez de scénarios sans chevauchement (${vus})`);
  });

  test('chaque moyenne est dans [min, max] des jours qui la composent', () => {
    const rnd = lcg(2718);
    const champs = [['repas', 'dataRepas'], ['volumeMl', 'dataRepas'], ['couches', 'dataCouche'],
      ['sleepMin', 'dataSommeil'], ['naps', 'dataSommeil'], ['longestSleepMin', 'dataSommeil']];
    for (let i = 0; i < 200; i++) {
      const r = Stats.compute(randomScenario(rnd), OPTS);
      for (const [champ, flag] of champs) {
        const el = r.days.filter(d => d.complete && d.tracked && d[flag]).map(d => d[champ]);
        const av = r.averages[champ];
        if (!el.length) { if (av !== null) throw new Error(`scénario ${i} : ${champ} devrait être null`); continue; }
        if (!(av >= Math.min(...el) - 1e-9 && av <= Math.max(...el) + 1e-9)) {
          throw new Error(`scénario ${i} : ${champ} ${av} hors [${Math.min(...el)}, ${Math.max(...el)}]`);
        }
      }
    }
  });

  test('résultat indépendant de l’ordre des événements, et idempotent', () => {
    const rnd = lcg(99991);
    for (let i = 0; i < 200; i++) {
      const evs = randomScenario(rnd);
      const ref = JSON.stringify(Stats.compute(evs, OPTS));
      if (JSON.stringify(Stats.compute(evs, OPTS)) !== ref) throw new Error(`scénario ${i} : non idempotent`);
      // ordre décroissant (ce que renvoie Store.all()) puis mélangé
      const desc = evs.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
      if (JSON.stringify(Stats.compute(desc, OPTS)) !== ref) throw new Error(`scénario ${i} : dépend du tri décroissant`);
      if (JSON.stringify(Stats.compute(shuffle(evs, rnd), OPTS)) !== ref) throw new Error(`scénario ${i} : dépend de l’ordre`);
    }
  });

  test('les épisodes sont toujours triés et cohérents', () => {
    const rnd = lcg(1234567);
    for (let i = 0; i < 200; i++) {
      const eps = Stats.sleepEpisodes(randomScenario(rnd), { nowMs: NOWMS });
      for (let k = 0; k < eps.length; k++) {
        const e = eps[k];
        if (!(e.endMs > e.startMs)) throw new Error(`scénario ${i} : épisode de durée nulle/négative`);
        if (e.min !== Math.round((e.endMs - e.startMs) / 60000)) throw new Error(`scénario ${i} : min incohérent`);
        if (k && eps[k - 1].startMs > e.startMs) throw new Error(`scénario ${i} : tri cassé`);
        const segs = Stats._splitAtMidnight(e);
        if (segs.reduce((t, g) => t + g.min, 0) !== segs[0].totalMin) throw new Error(`scénario ${i} : Σ segments ≠ totalMin`);
      }
    }
  });
};
