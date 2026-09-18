const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.env.TZ = 'Europe/Paris';
const root = path.join(__dirname, '..');
const c = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'stats.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'prediction.js'),'utf8')+';globalThis.M=SleepModels;',c);
const M = c.M;
const iso = ms => new Date(ms).toISOString();
const origin = new Date('2026-08-01T08:00:00+02:00').getTime();
const events = Array.from({length:90},(_,i)=>({id:String(i),action:'sommeil',ts:iso(origin+i*6*3600000),data:{end:iso(origin+i*6*3600000+(40+i%5*20)*60000)}}));
const now = origin+90*6*3600000;
const opts = {now};
test('aucune fuite du futur dans les prédictions déjà évaluées',()=>{
 const cutoff = origin+70*6*3600000+60000;
 const early = M.evaluate(events,{now:cutoff}).cases;
 const late = M.evaluate(events,opts).cases.filter(r=>r.realMs<=cutoff);
 assert.equal(early.length,late.length);
 for(let i=0;i<early.length;i++) assert.deepEqual(JSON.parse(JSON.stringify(early[i])),JSON.parse(JSON.stringify(late[i])),`cas ${i}`);
});
test('ancres et instants de comparaison identiques, erreurs finies, plages ordonnées',()=>{
 const result=M.evaluate(events,opts);
 assert.deepEqual(Array.from(new Set(result.cases.map(r=>r.elapsed))),[0,30,60,120]);
 for(const r of result.cases) for(const p of [r.active,r.challenger]) if(p){
   assert.ok(Number.isFinite(p.atMs));
   assert.ok(p.atMs>r.asOfMs);
   if(p.loMs!=null) assert.ok(p.loMs<=p.atMs && p.atMs<=p.hiMs);
 }
 assert.ok(result.summaries.every(s=>s.pairedN<=s.activeN && s.pairedN<=s.challengerN));
});
test('au départ les références retrouvent les médianes M6/M3 quand leur groupe est suffisant',()=>{
 const S=M.samples(events,opts);
 for(const target of ['onset','wake']){
  const anchor=now, id=target==='onset'?'M6':'M3';
  const result=M.predict(S,target,anchor,anchor,id);
  const samples=(target==='onset'?S.gaps:S.durations).filter(s=>s.atMs<=anchor && s.atMs>=anchor-14*86400000).slice(-40);
  const group=samples.filter(s=>target==='onset' ? ((M.hour(M.start(s,target))>=20||M.hour(M.start(s,target))<7)===(M.hour(anchor)>=20||M.hour(anchor)<7)) : Math.floor(M.hour(M.start(s,target))/6)===Math.floor(M.hour(anchor)/6));
  const values=(group.length>=5?group:samples).map(s=>s.min).sort((a,b)=>a-b);
  const expected=(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2;
  assert.equal(result.atMs,anchor+expected*60000);
 }
});
test('pas de prédiction inventée si historique vide ou tous les précédents sont dépassés',()=>{
 assert.equal(M.current([],opts).active,null);
 const S=M.samples(events,opts);
 for(const id of ['M3','H1']) assert.equal(M.predict(S,'wake',now-1000*60000,now,id),null);
});
test('un événement supprimé ne participe pas aux calculs',()=>{
 const a=M.evaluate(events,opts), b=M.evaluate([...events,{...events[0],id:'removed',deleted:true}],opts);
 assert.equal(JSON.stringify(a),JSON.stringify(b));
});
test('minuit : la distance horaire H1 est circulaire',()=>{
 const make = hour => Array.from({length:10},(_,i)=>{
  const start=new Date(2026,7,10+i,hour,0).getTime();return {min:hour===23?60:180,atMs:start+180*60000,ep:{startMs:start}};
 });
 const S={gaps:[],durations:[...make(23),...make(12)].sort((a,b)=>a.atMs-b.atMs)};
 const anchor=new Date(2026,7,20,0).getTime();
 assert.equal(M.predict(S,'wake',anchor,anchor,'H1').remainingMin,60);
});
test('le calcul courant ne modifie ni les événements ni les paramètres',()=>{
 const before=JSON.stringify(events), params=JSON.stringify(M.parameters);
 M.current(events,opts); M.evaluate(events,opts);
 assert.equal(JSON.stringify(events),before); assert.equal(JSON.stringify(M.parameters),params);
});
