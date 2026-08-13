/* =========================================================
   Gardes au niveau des SOURCES — pour les régressions qu'un test
   unitaire ne peut pas voir (bloc de démo oublié, cache périmé,
   arithmétique de jours en ms, version figée à la main…).
   ========================================================= */
'use strict';

module.exports = ({ suite, test, eq, deepEq, ok, Stats, ROOT, fs, path }) => {

  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const SRC = {
    app: read('app.js'), stats: read('stats.js'), index: read('index.html'),
    sw: read('sw.js'), styles: read('styles.css'),
  };
  // Lignes utiles (sans les commentaires en fin de ligne ni les lignes commentées)
  const codeLines = src => src.split('\n')
    .map((l, i) => ({ n: i + 1, txt: l.replace(/\/\/.*$/, '') }))
    .filter(l => l.txt.trim());

  suite('7. Gardes sur les sources');

  test('aucun bloc de démo (règle : à retirer avant tout push)', () => {
    for (const [nom, src] of Object.entries(SRC)) {
      const hits = codeLines(src).filter(l => /suivi-bebe-DEMO|DEMO_EVENTS|seedDemo/i.test(l.txt));
      eq(hits.length, 0, `${nom} : bloc de démo en ligne ${hits.map(h => h.n).join(', ')}`);
    }
  });

  test('cache du service worker aligné sur les ?v=N (aucun asset périmé)', () => {
    const versions = [...SRC.index.matchAll(/(?:href|src)="([^"]+)\?v=(\d+)"/g)]
      .map(m => ({ url: `${m[1]}?v=${m[2]}`, v: +m[2] }));
    ok(versions.length >= 4, `assets versionnés trouvés dans index.html (${versions.length})`);

    const cache = (SRC.sw.match(/const CACHE = 'suivi-bebe-v(\d+)'/) || [])[1];
    ok(cache, 'sw.js : CACHE au format suivi-bebe-vN');
    eq(+cache, Math.max(...versions.map(v => v.v)), 'CACHE = max des ?v=N de index.html');

    const assets = [...SRC.sw.matchAll(/'([^']+\?v=\d+)'/g)].map(m => m[1]);
    const manquants = versions.map(v => v.url).filter(u => !assets.includes(u));
    deepEq(manquants, [], 'toute URL versionnée de index.html est dans ASSETS');
    const orphelins = assets.filter(a => !versions.some(v => v.url === a));
    deepEq(orphelins, [], 'aucune URL périmée dans ASSETS');
  });

  test('arithmétique de jours : toujours via Math.round ou Stats.addDays', () => {
    // Un écart en ms divisé par 86 400 000 vaut 6,96 ou 7,04 jours autour d'un
    // changement d'heure : floor/ceil/troncature y perdent (ou ajoutent) un jour.
    const suspects = [];
    for (const [nom, src] of Object.entries({ app: SRC.app, stats: SRC.stats })) {
      for (const l of codeLines(src)) {
        if (!/86400000|864e5|24 ?\* ?60 ?\* ?60 ?\* ?1000/.test(l.txt)) continue;
        if (!/Math\.round/.test(l.txt)) suspects.push(`${nom}:${l.n}`);
      }
    }
    deepEq(suspects, [], 'division par un jour en ms sans Math.round');
  });

  test('la version exportée est dérivée de l’asset, jamais écrite à la main', () => {
    ok(/const APP_VERSION = /.test(SRC.app), 'app.js : APP_VERSION dérivée de document.currentScript');
    const ligne = codeLines(SRC.app).find(l => /app_version/.test(l.txt));
    ok(ligne, 'exportJSON expose app_version');
    ok(/APP_VERSION/.test(ligne.txt), `app_version doit utiliser APP_VERSION (ligne ${ligne && ligne.n})`);
    ok(!/'v\d+'|"v\d+"/.test(ligne.txt), 'aucune version en dur');
  });

  test('app.js passe bien les drapeaux de fiabilité à Stats.compute', () => {
    // Sans domainStart/firstCompleteDay, les moyennes se remettent à diviser par
    // des jours sans donnée (faux zéros) — régression silencieuse et invisible.
    const appels = [...SRC.app.matchAll(/Stats\.compute\(([\s\S]{0,260}?)\)\s*;/g)].map(m => m[1]);
    ok(appels.length >= 2, `appels à Stats.compute trouvés (${appels.length})`);
    appels.forEach((a, i) => {
      ok(/domainStart/.test(a) && /firstCompleteDay/.test(a), `appel #${i + 1} : domainStart + firstCompleteDay`);
    });
    ok(/DATA_START\s*=/.test(SRC.app) && /FIRST_COMPLETE_DAY\s*=/.test(SRC.app), 'constantes de fiabilité définies');
  });

  test('la découpe à minuit n’est pas dupliquée dans app.js', () => {
    ok(/Stats\.sleepSegments\(/.test(SRC.app), 'app.js délègue la découpe à Stats.sleepSegments');
    const dup = codeLines(SRC.app).filter(l => /setHours\(0, ?0, ?0, ?0\)/.test(l.txt) && !/^\s*(const|function) startOfDay/.test(l.txt));
    ok(dup.length <= 1, `pas de recalcul de minuit dispersé (${dup.map(d => d.n).join(', ')})`);
  });

  test('stats.js reste pur (testable hors navigateur)', () => {
    for (const motif of [/document\./, /localStorage/, /sessionStorage/, /fetch\(/, /alert\(/, /console\./]) {
      const hits = codeLines(SRC.stats).filter(l => motif.test(l.txt)).map(l => l.n);
      deepEq(hits, [], `stats.js ne doit pas utiliser ${motif}`);
    }
    ok(/const Stats = \{/.test(SRC.stats), 'point d’entrée `const Stats = {` (attendu par le chargeur de tests)');
  });

  test('surface publique de stats.js (contrat pour app.js et le prédictif)', () => {
    for (const k of ['compute', 'sleepSegments', 'sleepEpisodes', 'daysWindow', 'startOfDay', 'addDays', 'dayKey', 'isSameDay']) {
      eq(typeof Stats[k], 'function', `Stats.${k}`);
    }
    eq(Stats.SLEEP_MAX_MS, 16 * 60 * 60 * 1000, 'SLEEP_MAX_MS');
    eq(Stats.TEMP_ALERT, 38.0, 'TEMP_ALERT');
    deepEq([Stats.TEMP_MIN, Stats.TEMP_MAX], [34.0, 42.0], 'plage de température plausible');
    eq(Stats._overlapMin, undefined, 'ancienne règle de chevauchement supprimée (code mort)');
  });

  test('les types d’anomalies de stats.js sont tous affichés par app.js', () => {
    const q = Object.keys(Stats.compute([], { periodDays: 7, now: new Date(2026, 7, 13, 12, 0) }).quality);
    ok(q.length >= 7, `types d’anomalies (${q.length})`);
    const absents = q.filter(k => !new RegExp(`'${k}'`).test(SRC.app));
    deepEq(absents, [], 'chaque liste de quality a une entrée dans qTypes (sinon anomalie muette)');
  });
};
