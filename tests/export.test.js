/* =========================================================
   Export « Baby Scientist » — SPECS-baby-scientist-export.md §8
   ---------------------------------------------------------
   Ce qui est vérifié ici, c'est la partie PURE (l'extension analytique).
   Le téléchargement et l'enveloppe `meta` vivent dans app.js : ils sont
   couverts par les gardes sur les sources (suite 7).
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, deepEq, ok, Stats }) => {

  // Constantes RÉELLES de l'app (app.js) — les tests doivent casser si elles bougent.
  const BIRTH = new Date(2026, 7, 6, 5, 25);
  const DATA_START = { repas: new Date(2026, 7, 6), couche: new Date(2026, 7, 11), sommeil: new Date(2026, 7, 11) };
  const FIRST_COMPLETE_DAY = new Date(2026, 7, 7);
  const NOW = new Date('2026-08-17T07:02:45.065Z');

  const ev = (action, ts, data = {}) => ({ id: `${action}-${ts}`, action, data, ts, deleted: false });
  const build = (events, extra = {}) => Stats.babyScientistExtension(events, {
    now: NOW, birth: BIRTH, domainStart: DATA_START, firstCompleteDay: FIRST_COMPLETE_DAY, ...extra,
  });

  // Journal minimal, trié du plus récent au plus ancien comme Store.all().
  const JOURNAL = [
    ev('sommeil', '2026-08-17T06:11:00Z', { end: null }),
    ev('biberon', '2026-08-17T05:36:00Z', { ml: 100 }),
    ev('couche', '2026-08-12T09:00:00Z', { type: 'mixte' }),
    ev('tetee', '2026-08-06T04:20:00Z', { side: 'gauche', duration: 15 }),
  ];

  suite('17. Export Baby Scientist (extension analytique)');

  test('enveloppe : 7 clés exactement, versions séparées, aucun événement recopié', () => {
    const bs = build(JOURNAL);
    deepEq(Object.keys(bs), ['schema_version', 'subject', 'coverage',
      'event_annotations', 'context_periods', 'hypotheses', 'previous_runs'], 'clés de l’extension');
    eq(bs.schema_version, '1.0.0', 'schema_version de l’extension (≠ meta.schema_version)');
    eq(Stats.BS_SCHEMA_VERSION, '1.0.0', 'constante exposée');
    // L'extension décrit le journal, elle ne le duplique pas (§1).
    eq(bs.events, undefined, 'aucune clé events');
    eq(JSON.stringify(bs).includes('biberon-'), false, 'aucun id d’événement recopié');
  });

  test('subject : pseudonyme, référence d’âge, âge décimal à 3 décimales', () => {
    const bs = build(JOURNAL);
    eq(bs.subject.id, 'baby-1', 'identifiant neutre');
    eq(Stats.BS_SUBJECT_ID, 'baby-1', 'constante exposée');
    // Doit être IDENTIQUE à meta.exported_at (app.js passe le même instant).
    eq(bs.subject.age_reference_at, NOW.toISOString(), 'age_reference_at = instant d’export');
    // (2026-08-17T07:02:45.065Z − 2026-08-06T03:25:00Z) = 11 j 3 h 37 min 45,065 s
    eq(bs.subject.age_at_reference_days, 11.151, 'âge décimal arrondi à 3 décimales');
    eq(bs.subject.age_at_reference_days,
      Math.round((NOW.getTime() - BIRTH.getTime()) / 86400000 * 1000) / 1000, 'formule de la spec §4.4');
    eq(bs.subject.id === 'baby-1' && !('name' in bs.subject), true, 'aucun nom');
  });

  test('la date de naissance est omise par défaut, jamais déduite', () => {
    ok(!('birth_at' in build(JOURNAL).subject), 'birth_at absent par défaut (donnée identifiante)');
    eq(build(JOURNAL, { includeBirth: true }).subject.birth_at, BIRTH.toISOString(), 'présent sur demande explicite');
    // Sans naissance : null, jamais 0 (un âge de 0 jour serait un faux nouveau-né).
    eq(build(JOURNAL, { birth: null }).subject.age_at_reference_days, null, 'sans naissance → null');
  });

  test('l’âge d’un événement se recalcule sans la date de naissance (§4.4)', () => {
    const bs = build(JOURNAL);
    const ref = new Date(bs.subject.age_reference_at).getTime();
    JOURNAL.forEach(e => {
      const ts = new Date(e.ts).getTime();
      const attendu = Math.round((ts - BIRTH.getTime()) / 86400000 * 1000) / 1000;
      const calcule = bs.subject.age_at_reference_days - (ref - ts) / 86400000;
      ok(Math.abs(calcule - attendu) < 0.001, `${e.action} : âge reconstruit (${calcule} ≈ ${attendu})`);
    });
  });

  test('coverage : bornes = min/max des ts, quel que soit l’ordre d’entrée', () => {
    const bs = build(JOURNAL);
    eq(bs.coverage.event_start_at, '2026-08-06T04:20:00.000Z', 'plus ancien ts');
    eq(bs.coverage.event_end_at, '2026-08-17T06:11:00.000Z', 'plus récent ts');
    const inverse = Stats.babyScientistExtension(JOURNAL.slice().reverse(),
      { now: NOW, birth: BIRTH, domainStart: DATA_START, firstCompleteDay: FIRST_COMPLETE_DAY });
    deepEq(inverse.coverage, bs.coverage, 'résultat indépendant de l’ordre');
  });

  test('un ts illisible est ignoré, jamais remplacé par une date de repli', () => {
    const bs = build([ev('bain', 'nawak'), ...JOURNAL]);
    eq(bs.coverage.event_start_at, '2026-08-06T04:20:00.000Z', 'bornes inchangées');
    ok(bs.coverage.domains.routine, 'l’événement compte quand même pour la couverture du domaine');
  });

  test('journal vide : tout est null ou vide, rien n’est inventé', () => {
    for (const vide of [[], null, undefined]) {
      const bs = build(vide);
      eq(bs.coverage.event_start_at, null, 'event_start_at');
      eq(bs.coverage.event_end_at, null, 'event_end_at');
      deepEq(bs.hypotheses, [], 'hypotheses');
      deepEq(bs.previous_runs, [], 'previous_runs');
      // Les 3 domaines suivis restent déclarés : leur date de fiabilité existe
      // indépendamment des données (c'est justement ce qui distingue « pas encore
      // suivi » de « suivi, rien à signaler »).
      deepEq(Object.keys(bs.coverage.domains), ['feeding', 'diaper', 'sleep'], 'domaines déclarés');
    }
  });

  test('first_complete_local_date vient de FIRST_COMPLETE_DAY, pas du 1er événement', () => {
    eq(build(JOURNAL).coverage.first_complete_local_date, '2026-08-07', 'date civile locale');
    // Un journal qui commence bien après ne déplace pas le 1er jour complet…
    eq(build([ev('biberon', '2026-08-14T10:00:00Z', { ml: 90 })]).coverage.first_complete_local_date,
      '2026-08-07', 'insensible au 1er événement observé');
    // …et sans constante fournie, on ne devine pas.
    eq(build(JOURNAL, { firstCompleteDay: null }).coverage.first_complete_local_date, null, 'absente → null');
  });

  test('domaines : reliable_from vient de DATA_START, en heure locale avec décalage', () => {
    const d = build(JOURNAL).coverage.domains;
    deepEq(d.feeding, {
      actions: ['tetee', 'biberon'], reliable_from: '2026-08-06T00:00:00+02:00',
      recording_mode: 'best_effort', known_gaps: [],
    }, 'feeding');
    eq(d.diaper.reliable_from, '2026-08-11T00:00:00+02:00', 'diaper');
    eq(d.sleep.reliable_from, '2026-08-11T00:00:00+02:00', 'sleep');
    deepEq(d.feeding.known_gaps, [], 'une absence d’événements n’est pas un trou déclaré');
  });

  test('heure d’hiver : le décalage suit la date, il n’est jamais constant (§8)', () => {
    const d = build(JOURNAL, { domainStart: { repas: new Date(2026, 0, 15) } }).coverage.domains;
    eq(d.feeding.reliable_from, '2026-01-15T00:00:00+01:00', 'janvier → +01:00');
  });

  test('un domaine sans date de fiabilité ne prétend rien, et n’apparaît que s’il a des données', () => {
    const sans = build(JOURNAL).coverage.domains;
    ok(!sans.health && !sans.routine && !sans.milestone, 'aucun domaine fantôme');
    const avec = build([...JOURNAL, ev('temperature', '2026-08-15T20:00:00Z', { temp: 37.2 })]).coverage.domains;
    deepEq(avec.health, {
      actions: ['temperature', 'medicament'], reliable_from: null,
      recording_mode: 'unknown', known_gaps: [],
    }, 'health : déclaré sans date de fiabilité inventée');
    ok(build([...JOURNAL, ev('appris', '2026-08-16T18:00:00Z', { text: 'sourit' })]).coverage.domains.milestone,
      'milestone via appris');
  });

  test('un ancien type retiré des tuiles reste couvert (cordon)', () => {
    const d = build([...JOURNAL, ev('cordon', '2026-08-09T09:00:00Z')]).coverage.domains;
    ok(d.routine && d.routine.actions.includes('cordon'), 'cordon rattaché à routine');
    eq(d.routine.recording_mode, 'unknown', 'aucune fiabilité inventée pour autant');
  });

  test('tombstones exclus : ni bornes, ni domaine', () => {
    const bs = build([...JOURNAL, { ...ev('medicament', '2026-08-18T23:00:00Z', { name: 'X' }), deleted: true }]);
    eq(bs.coverage.event_end_at, '2026-08-17T06:11:00Z'.replace('Z', '.000Z'), 'borne inchangée');
    ok(!bs.coverage.domains.health, 'un événement supprimé ne crée pas de domaine');
  });

  test('registres : vides par défaut, transmis tels quels, bornés pour previous_runs', () => {
    const bs = build(JOURNAL);
    deepEq([bs.event_annotations, bs.context_periods, bs.hypotheses, bs.previous_runs], [[], [], [], []],
      'V1 : aucun import de résultats → 4 tableaux vides');

    const h = [{ id: 'H001', revision: 1, question: 'q', status: 'new', latest_result: null }];
    const runs = Array.from({ length: 14 }, (_, i) => ({ run_id: `BSR-${i}` }));
    const plein = build(JOURNAL, { hypotheses: h, previousRuns: runs, contextPeriods: [{ id: 'CTX001' }] });
    deepEq(plein.hypotheses, h, 'hypothèses transmises sans réécriture');
    eq(plein.previous_runs.length, Stats.BS_PREVIOUS_RUNS_MAX, 'index borné à 10');
    eq(plein.previous_runs[0].run_id, 'BSR-0', 'les 10 premières de la liste fournie');
    deepEq(plein.context_periods, [{ id: 'CTX001' }], 'contextes transmis');

    // Une valeur d'un autre type ne doit pas produire un champ invalide.
    for (const mauvais of [null, 42, 'H001', {}]) {
      deepEq(build(JOURNAL, { hypotheses: mauvais }).hypotheses, [], `hypotheses (${JSON.stringify(mauvais)}) → []`);
    }
  });

  test('sortie sérialisable : aucun undefined, aucun NaN, entrée non mutée', () => {
    const copie = JSON.parse(JSON.stringify(JOURNAL));
    const bs = build([...JOURNAL, ev('tetee', '2026-08-10T12:00:00Z'), ev('biberon', '2026-08-11T12:00:00Z', { ml: 'abc' })]);
    const scan = (v, chemin) => {
      if (v === undefined) throw new Error(`undefined à ${chemin}`);
      if (typeof v === 'number' && !isFinite(v)) throw new Error(`${v} à ${chemin}`);
      if (v && typeof v === 'object') Object.keys(v).forEach(k => scan(v[k], `${chemin}.${k}`));
    };
    scan(bs, 'bs');
    ok(true, 'aucune valeur non finie');
    deepEq(JSON.parse(JSON.stringify(bs)), bs, 'aller-retour JSON à l’identique');
    deepEq(JOURNAL, copie, 'le journal d’entrée n’est pas modifié');
  });

  test('tous les types d’action de l’app sont rattachés à un domaine', () => {
    // Un type ajouté aux tuiles/checklist sans domaine sortirait du fichier sans
    // couverture : l'analyste le verrait dans events[] sans savoir depuis quand
    // la saisie est fiable. La garde qui compare à ACTIONS est dans la suite 7.
    const mappes = new Set(Stats.BS_DOMAINS.flatMap(d => d.actions));
    for (const a of ['tetee', 'biberon', 'couche', 'sommeil', 'bain', 'temperature', 'medicament',
      'vitamined', 'ventre', 'yeux', 'nez', 'appris']) {
      ok(mappes.has(a), `${a} rattaché à un domaine`);
    }
    // Un même type ne doit pas être dans deux domaines (couverture ambiguë).
    const tous = Stats.BS_DOMAINS.flatMap(d => d.actions);
    eq(tous.length, new Set(tous).size, 'aucun type dans deux domaines');
  });
};
