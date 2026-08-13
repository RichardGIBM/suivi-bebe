#!/usr/bin/env node
/* =========================================================
   Suivi Bébé — Tests unitaires (zéro dépendance)
   -----------------------------------------------------------
   Lancement :   node tests/run.js
                 node tests/run.js stats     (ne joue que les suites "stats*")

   Deux précautions qui évitent les faux verts :
   1. Fuseau forcé à Europe/Paris (toutes les frontières de jour, la découpe à
      minuit et les tests d'heure d'été en dépendent) → si TZ est différent, le
      script se relance lui-même dans le bon fuseau.
   2. stats.js est chargé tel quel (fichier PUR, aucun DOM) via eval, en
      transformant `const Stats =` en `global.Stats =` : on teste EXACTEMENT le
      code livré, sans copie ni build.
   ========================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Paris';
if (process.env.TZ !== TZ) {
  const r = require('child_process').spawnSync(process.execPath, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, TZ } });
  process.exit(r.status == null ? 1 : r.status);
}

const ROOT = path.join(__dirname, '..');

/* ---------- Chargement du code testé ---------- */
function loadStats() {
  const src = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
  if (!src.includes('const Stats =')) throw new Error('stats.js : `const Stats =` introuvable (chargeur à adapter)');
  eval(src.replace('const Stats =', 'global.Stats ='));   // eslint-disable-line no-eval
  return global.Stats;
}

/* ---------- Harnais minimal ---------- */
const state = { suite: '', pass: 0, fail: 0, failures: [], asserts: 0 };

function suite(name) { state.suite = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }

function test(name, fn) {
  const before = state.asserts;
  try {
    fn();
    state.pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${state.asserts - before})\x1b[0m`);
  } catch (err) {
    state.fail++;
    state.failures.push({ suite: state.suite, name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`      ${String(err && err.message || err).split('\n').join('\n      ')}`);
  }
}

const show = v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function eq(actual, expected, msg) {
  state.asserts++;
  if (actual !== expected) throw new Error(`${msg || 'eq'} : attendu ${show(expected)}, obtenu ${show(actual)}`);
}
function near(actual, expected, tol, msg) {
  state.asserts++;
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg || 'near'} : attendu ${show(expected)} ±${tol}, obtenu ${show(actual)}`);
}
function deepEq(actual, expected, msg) {
  state.asserts++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'deepEq'} :\n  attendu ${b}\n  obtenu  ${a}`);
}
function ok(cond, msg) {
  state.asserts++;
  if (!cond) throw new Error(msg || 'ok : condition fausse');
}
function throws(fn, msg) {
  state.asserts++;
  try { fn(); } catch { return; }
  throw new Error(msg || 'throws : aucune exception levée');
}

/* ---------- Exécution ---------- */
const api = { suite, test, eq, near, deepEq, ok, throws, Stats: loadStats(), ROOT, fs, path };
const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && f.includes(filter)).sort();
if (!files.length) { console.error(`Aucun fichier de test (filtre "${filter}")`); process.exit(1); }

for (const f of files) require(path.join(__dirname, f))(api);

const total = state.pass + state.fail;
console.log(`\n${state.fail ? '\x1b[31m' : '\x1b[32m'}${state.pass}/${total} cas OK\x1b[0m · ${state.asserts} assertions · TZ=${TZ}`);
if (state.fail) {
  console.log('\n\x1b[31mÉchecs :\x1b[0m');
  state.failures.forEach(f => console.log(`  · ${f.suite} → ${f.name}`));
}
process.exit(state.fail ? 1 : 0);
