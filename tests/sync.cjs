// Tests réseau simulé de la vraie couche Store : node --test tests/sync.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.SYNC_APP_SOURCE || path.join(__dirname, '../app.js'), 'utf8');
process.env.TZ = 'Europe/Paris';
function setup(rows = [], { cap = 1000, failPage = -1, onPage, failSave = false, now = '2026-09-11T10:00:00Z' } = {}) {
  const storage = new Map();
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => { if (failSave && k === 'suivi-bebe-events') throw new Error('quota'); storage.set(k, v); } },
    setTimeout: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('const Store ='), source.indexOf('/* ---------- Configuration des actions')) + '\nglobalThis.store = Store;', context);
  const store = context.store;
  let calls = 0, subscribed;
  const sent = [];
  store._authed = true;
  store._sb = {
    from() {
      let cursor = null, limit = cap, from = -Infinity, columns;
      return {
        select(value) { columns = value; return this; }, order() { return this; },
        limit(n) { limit = Math.min(n, cap); return this; },
        gt(key, value) { assert.equal(key, 'id'); cursor = value; return this; },
        gte(key, value) { assert.equal(key, 'updated_at'); from = Date.parse(value); return this; },
        then(resolve, reject) {
          if (columns === 'updated_at') return Promise.resolve({ data: [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 1) }).then(resolve, reject);
          const index = calls++;
          onPage?.(index, store);
          return Promise.resolve(index === failPage ? { error: new Error('offline') } : {
            data: rows.filter(r => (cursor === null || r.id > cursor) && Date.parse(r.updated_at) >= from).slice(0, limit),
          }).then(resolve, reject);
        },
        async upsert(batch) { sent.push(...batch); return { error: null }; },
      };
    },
    channel() { return { on() { return this; }, subscribe(cb) { subscribed = cb; return this; } }; },
  };
  return { store, storage, sent, calls: () => calls, status: value => subscribed(value) };
}
const row = (n, data = {}) => ({ id: String(n).padStart(6, '0'), action: 'sommeil', data, ts: '2026-09-11T01:00:00Z', deleted: false, updated_at: '2026-09-11T01:00:00Z' });

test('récupère aussi les événements au-delà de 1 000 et les suppressions', async () => {
  const rows = Array.from({ length: 1251 }, (_, i) => row(i));
  rows[1250].deleted = true;
  const { store } = setup(rows);
  await store.refresh();
  assert.equal(store._load().length, 1251);
  assert.equal(store._byId.get('001250').deleted, true);
  assert.equal(store._syncState, 'ok');
});
test('supporte un plafond serveur inférieur au lot demandé', async () => {
  const { store } = setup(Array.from({ length: 251 }, (_, i) => row(i)), { cap: 100 });
  await store.refresh();
  assert.equal(store._load().length, 251);
});
test('une erreur de lecture ne devient pas un faux voyant vert', async () => {
  const { store } = setup([], { failPage: 0 });
  await store.refresh();
  assert.equal(store._syncState, 'offline');
});
test('une page en échec laisse le cache intact et conserve le statut d’erreur après envoi', async () => {
  const { store, sent } = setup(Array.from({ length: 501 }, (_, i) => row(i)), { failPage: 1 });
  store._load().push(row(9000)); store._reindex();
  store._loadQueue().set('009000', row(9000));
  await store.refresh();
  assert.equal(store._load().length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store._syncState, 'offline');
});
test('une modification locale pendant la lecture reste prioritaire et est envoyée', async () => {
  const { store, sent } = setup([row(1, { end: null })], {
    onPage(index, store) {
      if (index === 1) {
        const local = row(1, { end: '2026-09-11T02:00:00Z' });
        store._load().push(local); store._reindex();
        store._loadQueue().set(local.id, store._snapshot(local));
      }
    },
  });
  await store.refresh();
  assert.equal(store._byId.get('000001').data.end, '2026-09-11T02:00:00Z');
  assert.equal(sent[0].data.end, '2026-09-11T02:00:00Z');
  assert.equal(store._queue.size, 0);
});
test('la reconnexion temps réel lance un rattrapage des événements manqués', async () => {
  const { store, status } = setup();
  let refreshed = 0;
  store.refresh = async () => { refreshed++; };
  store._subscribeRealtime();
  status('CHANNEL_ERROR');
  assert.equal(store._syncState, 'offline');
  status('SUBSCRIBED');
  assert.equal(refreshed, 1);
});

function seed(store, storage, rows, checkpoint) {
  storage.set(store.KEY, JSON.stringify(rows));
  storage.set(store.SYNC_KEY, checkpoint);
}
test('chargement initial complet puis uniquement changements, y compris anciennes corrections et suppressions', async () => {
  const rows = Array.from({ length: 1201 }, (_, i) => ({ ...row(i), ts: '2026-08-01T12:00:00Z' }));
  const { store, storage, calls } = setup(rows);
  await store.refresh();
  assert.equal(store._load().length, 1201);
  assert.equal(storage.get(store.SYNC_KEY), rows[0].updated_at);
  rows[0] = { ...rows[0], data: { corrected: true }, updated_at: '2026-09-12T12:00:00Z' };
  rows[1] = { ...rows[1], deleted: true, updated_at: '2026-09-12T12:00:00Z' };
  // Le premier delta recouvre encore le dernier lot initial (marge de sécurité).
  await store.refresh();
  const before = calls();
  await store.refresh();
  assert.equal(calls() - before, 2); // une page de changements + page vide, pas tout le journal
  assert.equal(store._byId.get('000000').data.corrected, true);
  assert.equal(store._byId.get('000001').deleted, true);
  assert.equal(store._load().length, 1201);
});
test('reprend un repère persistant, inclut le recouvrement et ne dépend pas de l’horloge locale', async () => {
  const rows = [
    { ...row(0), updated_at: '2026-09-01T10:00:00Z' },
    { ...row(1), updated_at: '2026-09-11T11:58:00Z' },
    { ...row(2), updated_at: '2026-09-11T12:01:00Z', deleted: true },
  ];
  const { store, storage } = setup(rows, { now: '2030-01-01T00:00:00Z' });
  seed(store, storage, [rows[0]], '2026-09-11T12:00:00Z');
  await store.refresh();
  assert.equal(store._load().length, 3);
  assert.equal(storage.get(store.SYNC_KEY), rows[2].updated_at);
});
test('cache absent ou corrompu : ignore le repère et restaure tout', async () => {
  for (const cache of [undefined, '{broken']) {
    const { store, storage } = setup([row(0)]);
    storage.set(store.SYNC_KEY, '2026-09-15T12:00:00Z');
    if (cache) storage.set(store.KEY, cache);
    await store.refresh();
    assert.equal(store._load().length, 1);
  }
});
test('échec réseau ou stockage : aucun avancement du repère', async () => {
  for (const options of [{ failPage: 1, cap: 1 }, { failSave: true }]) {
    const { store, storage } = setup([row(0), row(1)], options);
    seed(store, storage, [], '2026-09-10T00:00:00Z');
    await store.refresh();
    assert.equal(storage.get(store.SYNC_KEY), '2026-09-10T00:00:00Z');
    assert.equal(store._syncState, 'offline');
  }
});
test('les demandes simultanées partagent un seul parcours', async () => {
  const { store, calls } = setup([row(0)]);
  await Promise.all([store._pullAll(), store._pullAll(), store._pullAll()]);
  assert.equal(calls(), 2);
});
test('un changement pendant le parcours sera relu même si son id est déjà dépassé', async () => {
  const rows = [row(0), row(1)];
  const { store, storage } = setup(rows, { cap: 1, onPage(index) {
    if (index === 1) rows[0] = { ...rows[0], data: { later: true }, updated_at: '2026-09-12T12:00:00Z' };
  } });
  await store.refresh();
  assert.equal(storage.get(store.SYNC_KEY), '2026-09-11T01:00:00Z');
  await store.refresh();
  assert.equal(store._byId.get('000000').data.later, true);
});
