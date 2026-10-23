// Exécute le vrai catalogue et le vrai Store, sans navigateur ni réseau.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function setup(storage = new Map()) {
  const c = vm.createContext({ crypto: { randomUUID }, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'personalization.js'), 'utf8') + '\n' +
    source.match(/^function ymd\(d\).*$/m)[0] + '\n' + source.slice(source.indexOf('const Store ='), source.indexOf('/* Frise du journal')) + '\nglobalThis.api = { Store, Personalization, ACTIONS };', c);
  return { ...c.api, storage };
}
const op = (target, field, value, n) => ({ id: String(n).padStart(4,'0'), action: '__ui_setting', ts: new Date(1800000000000 + n).toISOString(), data: { target, field, value } });
const derive = (api, rows) => api.Personalization.derive(api.ACTIONS, rows);
test('un réglage utilise la file persistée de synchronisation, sans polluer le journal', () => {
  const a = setup();
  a.Store.add('biberon', { ml: 180 });
  const pref = a.Store.add('__ui_setting', { target: 'biberon', field: 'name', value: 'Lait' });
  assert.equal(a.Store.all().length, 1);
  assert.equal(a.Store.byDay(new Date()).length, 1);
  assert.equal(a.Store.preferences().length, 1);
  assert.equal(a.Store._loadQueue().get(pref.id).action, '__ui_setting');
  const reopened = setup(a.storage);
  assert.equal(derive(reopened, reopened.Store.preferences()).tiles.find(a => a.id === 'biberon').name, 'Lait');
  assert.equal(reopened.Store.all()[0].data.ml, 180);
});
test('deux téléphones fusionnent les réglages indépendants dans tous les ordres', () => {
  const a = setup(), b = setup();
  const rows = [op('biberon','name','Lait',1),op('ventre','hidden',true,2),op('checklist','order',['nez','ventre'],3)];
  rows.forEach(row => a.Store._applyRealtime(row));
  rows.slice().reverse().forEach(row => b.Store._applyRealtime(row));
  assert.equal(JSON.stringify(derive(a,a.Store.preferences())),JSON.stringify(derive(b,b.Store.preferences())));
  assert.equal(derive(a,a.Store.preferences()).tiles.find(a=>a.id==='biberon').name,'Lait');
  assert.equal(derive(a,a.Store.preferences()).checks[0].id,'nez');
});
test('masquer ou renommer conserve les données et le descriptif historique', () => {
  const a = setup();
  a.Store.add('tetee',{duration:10,side:'gauche'});
  a.Store.add('__ui_setting',{target:'tetee',field:'name',value:'Allaitement'});
  const view=derive(a,a.Store.preferences());
  assert.equal(view.tiles.find(a=>a.id==='tetee').hidden,true);
  assert.equal(view.all.find(a=>a.id==='tetee').name,'Allaitement');
  assert.equal(a.Store.all()[0].data.duration,10);
  assert.equal(a.Store.all()[0].action,'tetee');
});
test('rétablir masque les ajouts sans perdre leur définition ni leurs événements', () => {
  const a=setup();
  const rows=[op('custom_test','definition',{name:'Massage',emoji:'👐'},1),op('biberon','name','Lait',2),op('tile','order',['bain'],3),op('*','reset',true,4)];
  const view=derive(a,rows);
  assert.equal(view.tiles.find(a=>a.id==='biberon').name,'Biberon');
  assert.equal(view.tiles[0].id,'tetee');
  assert.equal(view.checks.find(a=>a.id==='custom_test').hidden,true);
  assert.equal(view.all.find(a=>a.id==='custom_test').name,'Massage');
  const restored=derive(a,[...rows,op('custom_test','hidden',false,5)]);
  assert.equal(restored.checks.find(a=>a.id==='custom_test').hidden,false);
});
test('deux nouvelles cases sont indépendantes et les définitions invalides sont ignorées', () => {
  const a=setup();
  const rows=[op('custom_a','definition',{name:'Matin'},1),op('custom_b','definition',{name:'Soir'},2),op('custom_a','hidden',true,3),op('biberon','definition',{name:'Injection'},4),op('__proto__','definition',{name:'Injection'},5),op('custom_empty','definition',{name:' '},6)];
  const view=derive(a,rows);
  assert.equal(view.checks.find(a=>a.id==='custom_b').hidden,false);
  assert.equal(view.all.find(a=>a.id==='biberon').name,'Biberon');
  assert(!view.all.some(a=>a.id==='custom_empty'||a.id==='__proto__'));
});
test('une réception en double ne duplique pas les cases, et les tombstones sont ignorés', () => {
  const a=setup(),row=op('custom_a','definition',{name:'Soin'},1);
  a.Store._applyRealtime(row);a.Store._applyRealtime(row);
  assert.equal(a.Store.preferences().length,1);
  assert.equal(derive(a,[row,{...op('biberon','hidden',true,2),deleted:true}]).tiles.find(a=>a.id==='biberon').hidden,false);
});
test('les nouveaux soins sont couverts comme routine dans les exports analytiques', () => {
  const c=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root,'stats.js'),'utf8')+'\nglobalThis.stats=Stats;',c);
  const result=c.stats.babyScientistExtension([{id:'1',action:'custom_a',ts:'2026-10-23T10:00:00Z',data:{}}]);
  assert(result.coverage.domains.routine.actions.includes('custom_a'));
  assert.equal(c.stats.babyScientistExtension(null).coverage.event_start_at,null);
});

test('les exports JSON séparent les opérations de personnalisation du journal', () => {
  const a = setup();
  a.Store.add('biberon', { ml: 180 });
  a.Store.add('__ui_setting', { target: 'biberon', field: 'name', value: 'Lait' });
  const c = vm.createContext({ Store: a.Store, APP_VERSION: 'v45' });
  const start = source.indexOf('function buildRawExportPayload(');
  vm.runInContext(source.slice(start, source.indexOf('function exportJSON()', start)) + '\nglobalThis.payload = buildRawExportPayload(Store.all(), new Date());', c);
  assert.equal(c.payload.events.length, 1);
  assert.equal(c.payload.meta.count, 1);
  assert.equal(c.payload.personalization.operations[0].action, '__ui_setting');
  assert.equal(c.payload.personalization.schema_version, 1);
});
test('deux modifications simultanées du même champ convergent à la réception', () => {
  const a = setup();
  const x = op('biberon','name','A',1), y = { ...op('biberon','name','B',1), id: '9999' };
  assert.equal(derive(a,[x,y]).tiles.find(a=>a.id==='biberon').name,'B');
  assert.equal(derive(a,[y,x]).tiles.find(a=>a.id==='biberon').name,'B');
});
