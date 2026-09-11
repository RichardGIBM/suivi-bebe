// Tests réseau simulé de la vraie couche Store : node --test tests/sync.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.SYNC_APP_SOURCE || path.join(__dirname, '../app.js'), 'utf8');
function setup(rows = [], { cap = 1000, failPage = -1, onPage } = {}) {
  const storage = new Map();
  const context = vm.createContext({
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('const Store ='), source.indexOf('/* ---------- Configuration des actions')) + '\nglobalThis.store = Store;', context);
  const store = context.store;
  let calls = 0, subscribed;
  const sent = [];
  store._authed = true;
  store._sb = {
    from() {
      let cursor = null, limit = cap;
      return {
        select() { return this; }, order() { return this; },
        limit(n) { limit = Math.min(n, cap); return this; },
        gt(key, value) { assert.equal(key, 'id'); cursor = value; return this; },
        then(resolve, reject) {
          const index = calls++;
          onPage?.(index, store);
          return Promise.resolve(index === failPage ? { error: new Error('offline') } : {
            data: rows.filter(r => cursor === null || r.id > cursor).slice(0, limit),
          }).then(resolve, reject);
        },
        async upsert(batch) { sent.push(...batch); return { error: null }; },
      };
    },
    channel() { return { on() { return this; }, subscribe(cb) { subscribed = cb; return this; } }; },
  };
  return { store, sent, calls: () => calls, status: value => subscribed(value) };
}
const row = (n, data = {}) => ({ id: String(n).padStart(6, '0'), action: 'sommeil', data, ts: '2026-09-11T01:00:00Z', deleted: false });

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
