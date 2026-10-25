const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.env.TZ = 'Europe/Paris';
const src = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const c = vm.createContext({});
const helpers = ['startOfDay','ymd','isSameDay','hhmmInput'].map(name => src.match(new RegExp('^function '+name+'\\(.*$', 'm'))[0]).join('\n');
vm.runInContext(fs.readFileSync(path.join(__dirname,'../time.js'),'utf8')+'\n'+helpers+'\n'+src.slice(src.indexOf('function wireTimeField('),src.indexOf('function validTimeFields('))+'\nglobalThis.api={LocalTime,wireTimeField};',c);
const { LocalTime, wireTimeField } = c.api;
function editor(iso) {
  const base = new Date(iso);
  const input = { value: `${String(base.getHours()).padStart(2,'0')}:${String(base.getMinutes()).padStart(2,'0')}`, setCustomValidity(v) { this.error=v; } };
  const choice = {}, warning = {}, buttons = [-5,5].map(n=>({dataset:{step:String(n)}}));
  const root = { querySelector: s=>s==='.time-input'?input:s==='.time-occurrence'?choice:warning, querySelectorAll: ()=>buttons };
  return { get: wireTimeField(root,base), input,choice,warning,buttons };
}
test('les deux occurrences de 02h30 en hiver sont des instants distincts',()=>{
  const dates=LocalTime.candidates(new Date('2026-10-25T12:00:00+01:00'),2,30);
  assert.equal(dates.length,2);
  assert.equal(dates[0].toISOString(),'2026-10-25T00:30:00.000Z');
  assert.equal(dates[1].toISOString(),'2026-10-25T01:30:00.000Z');
});
test('ouvrir puis enregistrer ne change aucune occurrence ni les secondes',()=>{
  for(const iso of ['2026-10-25T02:30:42.123+02:00','2026-10-25T02:30:42.123+01:00']){
    const e=editor(iso);assert.equal(e.get().toISOString(),new Date(iso).toISOString());assert.equal(e.choice.hidden,false);
  }
});
test('plus et moins suivent le temps réel à travers le recul',()=>{
  const e=editor('2026-10-25T02:58:00+02:00');e.buttons[1].onclick();
  assert.equal(e.input.value,'02:03');assert.equal(e.get().toISOString(),'2026-10-25T01:03:00.000Z');
  e.buttons[0].onclick();assert.equal(e.get().toISOString(),'2026-10-25T00:58:00.000Z');
});
test('la deuxième occurrence peut être choisie explicitement',()=>{
  const e=editor('2026-10-25T02:30:00+02:00');
  e.choice.value=String(Date.parse('2026-10-25T02:30:00+01:00'));e.choice.onchange();
  assert.equal(e.get().toISOString(),'2026-10-25T01:30:00.000Z');
});
test('un réveil saisi après le recul conserve le bon fuseau',()=>{
  const e=editor('2026-10-25T03:10:00+01:00');e.input.value='02:45';e.input.oninput();
  assert.equal(e.get().toISOString(),'2026-10-25T01:45:00.000Z');
});
test('les heures inexistantes du printemps sont invalides et le pas les franchit',()=>{
  const e=editor('2026-03-29T01:58:00+01:00');e.buttons[1].onclick();assert.equal(e.input.value,'03:03');
  e.input.value='02:30';e.input.oninput();assert(e.input.error);assert(Number.isNaN(e.get().getTime()));
});
test('frise : 13h le matin d’hiver, 11h au printemps et 12h les jours ordinaires',()=>{
  for(const [date,minutes] of [['2026-10-25',780],['2026-03-29',660],['2026-10-26',720]]){
    const d=new Date(date+'T12:00:00'),b=LocalTime.band(d,0,12);assert.equal(b.end,minutes);
    assert.equal(LocalTime.band(d,12,24).end-b.end,720);
    assert.equal((new Date(date+'T08:00:00')-new Date(date+'T00:00:00'))/60000,b.at(8));
  }
  const b=LocalTime.band(new Date('2026-10-25T12:00:00'),0,12);
  assert.equal(b.ticks.filter(t=>t.label.startsWith('2h')).length,2);
  assert.equal(b.dayEnd,1500);
});
test('un jour normal garde une seule heure et les pas ne changent pas de date',()=>{
  const e=editor('2026-10-26T23:58:00+01:00');e.buttons[1].onclick();assert.equal(e.input.value,'23:58');assert.equal(e.choice.hidden,true);
});

test('le rendu réel de la frise aligne les événements sur leurs heures locales',()=>{
  const node = () => ({ children: [], style: {}, appendChild(x) { this.children.push(x); }, addEventListener() {} });
  const ctx=vm.createContext({ document: { createElement: node }, fmtDuration: String });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../time.js'),'utf8')+'\n'+helpers+'\n'+src.slice(src.indexOf('function renderJournalBand('),src.indexOf('/* ---------- Popover'))+`\nconst selectedDate=new Date('2026-10-25T12:00:00'); const JOURNAL_LANES=[{actions:['biberon','sommeil']}]; const ACTION_MAP={biberon:{emoji:'B',color:'blue'},sommeil:{color:'green'}}; globalThis.render=renderJournalBand;`,ctx);
  const morning=ctx.render({startH:0,endH:12},[{action:'biberon',ts:'2026-10-25T08:00:00+01:00'}],{isToday:false,nowMin:0});
  const pin=morning.children[1].children[1].children[0].children[0];
  assert(pin.style.cssText.includes('left:'+ (540/780*100) +'%'));
  const evening=ctx.render({startH:12,endH:24},[{action:'biberon',ts:'2026-10-25T23:30:00+01:00'}],{isToday:false,nowMin:0});
  assert.equal(evening.children[1].children[1].children[0].children.length,1);
});
