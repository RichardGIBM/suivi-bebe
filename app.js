/* =========================================================
   Suivi Bébé — Phase 1 (prototype local)
   Données dans localStorage via la couche `Store` (remplaçable
   par Supabase en Phase 3 sans toucher au reste de l'app).

   Modèle unique = un journal d'événements :
     { id, action, data:{}, ts }
   C'est la brique qui alimentera le journal, la vue "Appris",
   et plus tard le dashboard, la heatmap calendrier et l'export.
   ========================================================= */

/* Version de l'app = celle de l'asset lui-même (index.html charge
   `app.js?v=N`, aligné sur CACHE dans sw.js) → rien à maintenir à la main
   dans les exports. */
const APP_VERSION = (() => {
  try {
    const v = new URL(document.currentScript.src).searchParams.get('v');
    return v ? 'v' + v : 'inconnue';
  } catch { return 'inconnue'; }
})();

/* ---------- Couche de données ----------
   Modèle : journal d'événements { id, action, data, ts, deleted }.
   - Source de vérité locale = localStorage (offline-first, rendu instantané).
   - Synchro Supabase (Phase 3) EN PLUS, sans changer l'API publique :
     chaque écriture est mise dans une file (`_queue`, coalescée par id)
     puis "flushée" (upsert) vers le serveur ; le serveur estampe
     `updated_at` (trigger). Le temps réel + un pull fusionnent les
     changements distants. Règle de conflit : une écriture encore en file
     locale l'emporte ; sinon on adopte la version serveur (autoritaire).
   - Suppression = soft-delete (`deleted:true`, tombstone) → se propage. */
const Store = {
  KEY: 'suivi-bebe-events',
  QKEY: 'suivi-bebe-queue',
  MIGKEY: 'suivi-bebe-migrated',
  _cache: null,      // tableau de TOUTES les lignes (y compris deleted)
  _byId: null,       // Map id -> ligne (mêmes références que _cache)
  _queue: null,      // Map id -> snapshot en attente d'envoi
  _flushing: false,  // verrou de flush
  _sb: null,         // client Supabase
  _authed: false,    // session active ?
  _channel: null,    // canal Realtime
  _syncState: 'local',

  /* ----- Cache local ----- */
  _load() {
    if (this._cache) return this._cache;
    try {
      const parsed = JSON.parse(localStorage.getItem(this.KEY));
      this._cache = Array.isArray(parsed) ? parsed : [];
    } catch { this._cache = []; }
    this._reindex();
    return this._cache;
  },
  _reindex() {
    this._byId = new Map();
    for (const e of this._cache) this._byId.set(e.id, e);
  },
  _save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this._cache));
    } catch (e) {
      // Stockage plein, bloqué, ou navigation privée : on prévient au lieu de planter
      if (typeof toast === 'function') toast('⚠️ Impossible d’enregistrer (stockage indisponible)');
      return;
    }
    this._notify();
  },

  /* ----- File d'envoi (persistée pour survivre au hors-ligne) ----- */
  _loadQueue() {
    if (this._queue) return this._queue;
    this._queue = new Map();
    try {
      const parsed = JSON.parse(localStorage.getItem(this.QKEY));
      if (parsed && typeof parsed === 'object') {
        for (const k of Object.keys(parsed)) this._queue.set(k, parsed[k]);
      }
    } catch { /* file illisible : on repart d'une file vide */ }
    return this._queue;
  },
  _saveQueue() {
    try {
      const obj = {};
      for (const [k, v] of this._queue) obj[k] = v;
      localStorage.setItem(this.QKEY, JSON.stringify(obj));
    } catch { /* non bloquant */ }
  },
  _snapshot(row) {
    return { id: row.id, action: row.action, data: { ...(row.data || {}) }, ts: row.ts, deleted: !!row.deleted };
  },
  _enqueue(row) {
    this._loadQueue();
    this._queue.set(row.id, this._snapshot(row));
    this._saveQueue();
    this._flush();
  },

  /* ----- API publique (INCHANGÉE pour l'UI) ----- */
  all() { return this._load().filter(e => !e.deleted).sort((a, b) => new Date(b.ts) - new Date(a.ts)); },
  byDay(date) { const k = ymd(date); return this.all().filter(e => ymd(new Date(e.ts)) === k); },
  byAction(action) { return this.all().filter(e => e.action === action); },
  // Brique pour dashboard / heatmap : événements entre deux dates incluses
  range(from, to) {
    const a = startOfDay(from).getTime(), b = startOfDay(to).getTime();
    return this.all().filter(e => { const t = startOfDay(new Date(e.ts)).getTime(); return t >= a && t <= b; });
  },
  // Brique pour l'export (JSON pour l'instant)
  exportJSON() { return JSON.stringify(this.all(), null, 2); },

  add(action, data = {}, ts = new Date()) {
    const event = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      action, data, ts: ts.toISOString(), deleted: false,
    };
    this._load().push(event);
    this._byId.set(event.id, event);
    this._save();
    this._enqueue(event);
    return event;
  },
  update(id, patch) {
    this._load();
    const ev = this._byId.get(id);
    if (!ev) return;
    Object.assign(ev, patch);
    this._save();
    this._enqueue(ev);
  },
  // Fusionne des clés dans event.data
  patchData(id, dataPatch) {
    this._load();
    const ev = this._byId.get(id);
    if (!ev) return;
    ev.data = { ...(ev.data || {}), ...dataPatch };
    this._save();
    this._enqueue(ev);
  },
  remove(id) {
    this._load();
    const ev = this._byId.get(id);
    if (!ev) return;
    ev.deleted = true;                 // tombstone (soft-delete) → se propage à l'autre appareil
    this._save();
    this._enqueue(ev);
  },
  lastOf(action) { return this.all().find(e => e.action === action) || null; },

  // Rafraîchissement manuel (tirer pour rafraîchir) / au retour au premier plan :
  // re-fusionne l'état serveur puis vide la file. No-op si non connecté.
  async refresh() {
    if (this._authed && this._sb) { await this._pullAll(); this._flush(); }
    return true;
  },

  _subs: [],
  subscribe(cb) { this._subs.push(cb); },
  _notify() { this._subs.forEach(cb => cb()); },

  /* ============================================================
     Synchro Supabase
     ============================================================ */
  hasLocalCache() { return this._load().some(e => !e.deleted); },

  initSupabase() {
    const cfg = window.SB_CONFIG;
    if (!cfg || !cfg.url || !cfg.anon || cfg.url.includes('XXXX')) return false; // pas encore configuré → 100 % local
    if (!window.supabase || !window.supabase.createClient) return false;
    this._sb = window.supabase.createClient(cfg.url, cfg.anon, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    return true;
  },

  async restoreSession() {
    if (!this._sb) return false;
    try {
      const { data } = await this._sb.auth.getSession();
      if (data && data.session) { await this._onAuthed(); return true; }
    } catch { /* réseau indisponible : on reste en local */ }
    return false;
  },

  async signIn(passphrase) {
    if (!this._sb) throw new Error('Synchro non configurée');
    const cfg = window.SB_CONFIG;
    const { error } = await this._sb.auth.signInWithPassword({ email: cfg.email, password: passphrase });
    if (error) throw error;
    await this._onAuthed();
    return true;
  },

  async _onAuthed() {
    this._authed = true;
    this._setSync('pending');
    await this._migrateOnce();   // remonte les données locales existantes (1re fois)
    await this._pullAll();       // fusionne l'état serveur (ne remplace jamais les ids en file)
    this._subscribeRealtime();
    this._flush();
  },

  // Migration unique local → serveur : enfile tout l'existant, une seule fois.
  async _migrateOnce() {
    if (localStorage.getItem(this.MIGKEY) === '1') return;
    this._load();
    this._loadQueue();
    for (const e of this._cache) this._queue.set(e.id, this._snapshot(e));
    this._saveQueue();
    localStorage.setItem(this.MIGKEY, '1');
  },

  async _pullAll() {
    if (!this._sb || !this._authed) return;
    this._load();
    this._loadQueue();
    let data, error;
    try { ({ data, error } = await this._sb.from('events').select('*')); }
    catch (e) { this._setSync('offline'); return; }
    if (error || !Array.isArray(data)) { this._setSync('offline'); return; }
    let changed = false;
    for (const row of data) {
      if (this._queue.has(row.id)) continue;           // écriture locale en attente = prioritaire
      const incoming = { id: row.id, action: row.action, data: row.data || {}, ts: row.ts, deleted: !!row.deleted };
      const local = this._byId.get(row.id);
      if (!local) { this._cache.push(incoming); this._byId.set(row.id, incoming); changed = true; }
      else { Object.assign(local, incoming); changed = true; } // serveur autoritaire
    }
    if (changed) this._save();
    this._setSync(this._queue.size ? 'pending' : 'ok');
  },

  _subscribeRealtime() {
    if (!this._sb || this._channel) return;
    this._channel = this._sb
      .channel('events-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' },
        (payload) => this._applyRealtime(payload.new || payload.old))
      .subscribe();
  },

  _applyRealtime(row) {
    if (!row || !row.id) return;
    this._loadQueue();
    if (this._queue.has(row.id)) return;               // notre propre écriture en attente : ignorer l'écho
    this._load();
    const incoming = { id: row.id, action: row.action, data: row.data || {}, ts: row.ts, deleted: !!row.deleted };
    const local = this._byId.get(row.id);
    if (local &&
        local.ts === incoming.ts &&
        !!local.deleted === incoming.deleted &&
        JSON.stringify(local.data) === JSON.stringify(incoming.data)) {
      return;                                          // écho identique : rien à faire
    }
    if (local) Object.assign(local, incoming);
    else { this._cache.push(incoming); this._byId.set(row.id, incoming); }
    this._save();
  },

  async _flush() {
    if (this._flushing || !this._authed || !this._sb) return;
    this._loadQueue();
    if (this._queue.size === 0) { this._setSync('ok'); return; }
    this._flushing = true;
    this._setSync('pending');
    try {
      const rows = Array.from(this._queue.values());
      const { error } = await this._sb.from('events').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      // Retire les lignes envoyées, sauf si ré-écrites entre-temps (pendant l'await)
      for (const r of rows) {
        const cur = this._queue.get(r.id);
        if (cur && cur.ts === r.ts && !!cur.deleted === !!r.deleted &&
            JSON.stringify(cur.data) === JSON.stringify(r.data)) {
          this._queue.delete(r.id);
        }
      }
      this._saveQueue();
      this._setSync(this._queue.size ? 'pending' : 'ok');
    } catch (e) {
      this._setSync('offline');                        // on garde la file : retry au prochain flush / retour online
    } finally {
      this._flushing = false;
      if (this._authed && this._queue.size) setTimeout(() => this._flush(), 1000);
    }
  },

  _setSync(state) {
    this._syncState = state;
    if (typeof updateSyncPill === 'function') updateSyncPill(state);
  },
};

/* ---------- Configuration des actions ----------
   place: 'tile' → gros bouton (ouvre un sheet)
   place: 'checklist' → case à cocher quotidienne (un tap = fait)   */
const ACTIONS = [
  // Tuiles
  { id: 'tetee',       name: 'Tétée',            emoji: '🤱', color: 'var(--c-tetee)',       place: 'tile', showSince: true },
  { id: 'biberon',     name: 'Biberon',          emoji: '🍼', color: 'var(--c-biberon)',     place: 'tile', showSince: true },
  { id: 'couche',      name: 'Couche',           emoji: '🧷', color: 'var(--c-couche)',      place: 'tile', showSince: true },
  { id: 'sommeil',     name: 'Sommeil',          emoji: '😴', color: 'var(--c-sommeil)',     place: 'tile', showSince: true },
  { id: 'bain',        name: 'Bain',             emoji: '🛁', color: 'var(--c-bain)',        place: 'tile' },
  { id: 'temperature', name: 'Température',       emoji: '🌡️', color: 'var(--c-temperature)', place: 'tile' },
  { id: 'medicament',  name: 'Médicament',       emoji: '💊', color: 'var(--c-medicament)',  place: 'tile' },
  // Checklist quotidienne
  { id: 'vitamined',   name: 'Vitamine D',       emoji: '💧', color: 'var(--c-vitamined)',   place: 'checklist', short: 'Vit. D' },
  { id: 'ventre',      name: 'Temps sur le ventre', emoji: '🤸', color: 'var(--c-ventre)',   place: 'checklist', short: 'Ventre' },
  { id: 'yeux',        name: 'Yeux',             emoji: '👁️', color: 'var(--c-soins)',       place: 'checklist' },
  { id: 'nez',         name: 'Nez',              emoji: '👃', color: 'var(--c-soins)',       place: 'checklist' },
];
const ACTION_MAP = Object.fromEntries(ACTIONS.map(a => [a.id, a]));
const TILE_ACTIONS = ACTIONS.filter(a => a.place === 'tile');
const CHECKLIST_ACTIONS = ACTIONS.filter(a => a.place === 'checklist');

/* Frise du journal — pistes par domaine (l'icône de chaque marque suffit,
   pas de libellé de piste à gauche) et découpe du jour en 2 bandes de 12 h.
   Les soins (bain/température/médicament) restent visibles en vue Liste. */
const JOURNAL_LANES = [
  { key: 'repas',   actions: ['tetee', 'biberon'] },
  { key: 'sommeil', actions: ['sommeil'] },
  { key: 'couche',  actions: ['couche'] },
];
const JOURNAL_BANDS = [{ startH: 0, endH: 12 }, { startH: 12, endH: 24 }];

/* Vues (barre d'onglets) — extensible : ajouter 'calendrier' plus tard.
   `when` (optionnel) : onglet affiché seulement si la condition est vraie. */
const VIEWS = [
  { id: 'suivi',  label: 'Suivi',  emoji: '📋' },
  { id: 'appris', label: 'Appris', emoji: '✨' },
  { id: 'stats',  label: 'Stats',  emoji: '📊' },
  // Onglet expérimental : apparaît dès qu'UN des deux prédicteurs a un point de
  // donnée (§4 de RECOS-prediction-sommeil-v5.md) — inutile d'exposer un labo vide.
  { id: 'prediction', label: 'Prédiction', emoji: '🔮', when: () => Stats.hasSleepSamples(Store.all(), { domainStart: DATA_START }) },
];

/* Fiabilité des données (précision) — les stats ne doivent pas afficher de
   faux zéros ni de journées partielles comme si elles étaient complètes.
   - Naissance le 6 août 2026 à 5h25 → le 6 août est un jour PARTIEL (exclu des
     moyennes, affiché atténué), les tétées/biberons sont fiables dès la naissance.
   - Couches & sommeil : saisie fiable seulement à partir d'AUJOURD'HUI (11 août).
     Avant, on n'affiche PAS 0 (donnée absente ≠ zéro) : c'est un trou de données. */
const DATA_START = {
  repas:   new Date(2026, 7, 6),    // depuis la naissance (mois 0-indexé : 7 = août)
  couche:  new Date(2026, 7, 11),   // fiable à partir d'aujourd'hui
  sommeil: new Date(2026, 7, 11),
};
// 1er jour CIVIL COMPLET (le 6 août est incomplet : née à 5h25) → 1re journée moyennable
const FIRST_COMPLETE_DAY = new Date(2026, 7, 7);
// Naissance (heure exacte) — sert l'âge affiché par l'onglet Prédiction
const BIRTH = new Date(2026, 7, 6, 5, 25);

/* Couleurs de dataviz VALIDÉES (charte : CVD-safe, contraste ≥ 3:1 sur fond clair).
   Distinctes des pastels d'UI (--c-*), qui échouent au validateur pour des marques
   de données (2 séries sein/biberon indiscernables même en vision normale).
     sein    = orange  #eb6834   \  paire catégorielle CVD-safe (ΔE ~25)
     biberon = bleu    #2a78d6   /  → carte « Sein vs Biberon » + « Part du biberon »
     vert    = #6f9e57  (sommeil / couches : séries uniques, contraste OK) */
const CHART = { sein: '#eb6834', biberon: '#2a78d6', vert: '#6f9e57', grid: '#e7e8ec', ink: '#8a8a93' };

/* Résumé lisible d'un événement */
function describe(ev) {
  const d = ev.data || {};
  switch (ev.action) {
    case 'tetee':       return d.side ? `Côté ${d.side}` + (d.duration ? ` · ${d.duration} min` : '') : '';
    case 'biberon':     return d.ml ? `${d.ml} ml bus` : '';
    case 'couche':      return d.type ? capitalize(d.type) : '';
    case 'temperature': return d.temp != null ? `${fmtTemp(d.temp)} °C` : '';
    case 'medicament':  return d.name ? d.name : 'Médicament';
    case 'sommeil':     return !d.end ? 'En cours…' : `→ ${hhmm(d.end)} · ${fmtDuration(durMin(ev.ts, d.end))}`;
    case 'appris':      return d.text || '';
    default:            return '';
  }
}

/* ---------- État ---------- */
let selectedDate = startOfDay(new Date());
let currentView = 'suivi';
let statsPeriod = 7;              // fenêtre de la vue Stats (7 / 14 / 30 jours)
let journalView = localStorage.getItem('suivi-bebe-journal-view') === 'timeline' ? 'timeline' : 'list';

/* ---------- Helpers date/heure ---------- */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function ymd(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function isSameDay(a, b) { return ymd(a) === ymd(b); }
function hhmm(d) { return new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function pad2(n) { return String(n).padStart(2, '0'); }
function minOf(ts) { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); } // minutes depuis minuit
function hhmmInput(d) { return new Date(d).toTimeString().slice(0, 5); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmtTemp(t) { return Number(t).toFixed(1).replace('.', ','); }
function durMin(a, b) { return Math.round((new Date(b) - new Date(a)) / 60000); }
function fmtDuration(min) {
  if (min < 0) min = 0;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}
function defaultTs() {
  const now = new Date();
  if (isSameDay(selectedDate, startOfDay(now))) return now;
  const d = new Date(selectedDate); d.setHours(12, 0, 0, 0); return d;
}
function relative(ts) {
  const diffMin = Math.round((Date.now() - new Date(ts)) / 60000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  if (h < 24) return `il y a ${h}h${m ? String(m).padStart(2, '0') : ''}`;
  return `il y a ${Math.floor(h / 24)} j`;
}
// Dodo en cours = sommeil sans fin, démarré il y a moins de 16 h.
// (autorise une nuit complète, mais ignore un dodo oublié qui gonflerait sans fin)
const SLEEP_MAX_MS = 16 * 60 * 60 * 1000;
function activeSleep() {
  return Store.all().find(e =>
    e.action === 'sommeil' &&
    !(e.data && e.data.end) &&
    (Date.now() - new Date(e.ts).getTime()) < SLEEP_MAX_MS
  ) || null;
}

/* ---------- Éditeur d'heure réutilisable (− / + = ±5 min) ---------- */
function timeFieldHTML(date, label = 'Heure') {
  return `
    <div class="sheet-section-label">${label}</div>
    <div class="time-edit">
      <button type="button" class="time-step" data-step="-5">−</button>
      <input type="time" class="time-input" value="${hhmmInput(date)}" />
      <button type="button" class="time-step" data-step="5">+</button>
    </div>`;
}
// Branche les ± d'un champ heure. root = élément conteneur, baseDate = jour de référence.
function wireTimeField(root, baseDate, onChange) {
  const input = root.querySelector('.time-input');
  // Minutes depuis minuit à partir du champ ; null si vide/invalide
  const readTotal = () => {
    const [h, m] = input.value.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const getDate = () => {
    const total = readTotal();
    const d = new Date(baseDate);
    // Repli sur l'heure de base si le champ a été vidé/est invalide
    if (total === null) return d;
    d.setHours(0, total, 0, 0);
    return d;
  };
  const fire = () => onChange && onChange(getDate());
  root.querySelectorAll('.time-step').forEach(btn => {
    btn.onclick = () => {
      const base = readTotal();
      const from = base === null ? (baseDate.getHours() * 60 + baseDate.getMinutes()) : base;
      let total = from + Number(btn.dataset.step);
      total = Math.max(0, Math.min(24 * 60 - 1, total));
      const d = new Date(baseDate); d.setHours(0, total, 0, 0);
      input.value = hhmmInput(d); fire();
    };
  });
  input.oninput = fire;
  return getDate;
}

/* ============================================================
   RENDU
   ============================================================ */
function renderTabbar() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  VIEWS.filter(v => !v.when || v.when()).forEach(v => {
    const b = document.createElement('button');
    b.className = 'tab' + (currentView === v.id ? ' active' : '');
    b.innerHTML = `<span class="tab-emoji">${v.emoji}</span><span>${v.label}</span>`;
    b.onclick = () => showView(v.id);
    bar.appendChild(b);
  });
}

function showView(id) {
  currentView = id;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${id}`; });
  renderCurrent();
  window.scrollTo(0, 0);
}

function renderCurrent() {
  renderTabbar();
  if (currentView === 'suivi') renderSuivi();
  else if (currentView === 'stats') renderStats();
  else if (currentView === 'appris') renderAppris();
  else if (currentView === 'prediction') renderPrediction();
}

/* ---------- Vue SUIVI ---------- */
function renderSuivi() {
  renderHeader();
  renderStatusStrip();
  renderChecklist();
  renderGrid();
  renderLearnedToday();
  renderTimeline();
}

function renderHeader() {
  const today = startOfDay(new Date());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const label = document.getElementById('dateLabel');
  const sub = document.getElementById('dateSub');
  if (isSameDay(selectedDate, today)) label.textContent = "Aujourd'hui";
  else if (isSameDay(selectedDate, yesterday)) label.textContent = "Hier";
  else label.textContent = selectedDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  sub.textContent = selectedDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('nextDay').disabled = isSameDay(selectedDate, today);
  document.body.classList.toggle('other-day', !isSameDay(selectedDate, today));
}

function renderStatusStrip() {
  const strip = document.getElementById('statusStrip');
  strip.innerHTML = '';
  TILE_ACTIONS.filter(a => a.showSince).forEach(a => {
    const last = Store.lastOf(a.id);
    let value = '—';
    if (a.id === 'sommeil') {
      const active = activeSleep();
      if (active) value = `⏱ ${fmtDuration(durMin(active.ts, new Date()))}`;
      else if (last) value = relative(last.data && last.data.end ? last.data.end : last.ts);
    } else if (last) {
      value = relative(last.ts);
    }
    value = value.replace('il y a ', '');
    const pill = document.createElement('div');
    pill.className = 'status-pill';
    pill.innerHTML = `<div class="sp-label">${a.emoji} ${a.name}</div><div class="sp-value">${value}</div>`;
    strip.appendChild(pill);
  });
}

function renderChecklist() {
  const wrap = document.getElementById('checklist');
  wrap.innerHTML = '';
  const dayEvents = Store.byDay(selectedDate);
  CHECKLIST_ACTIONS.forEach(a => {
    const todays = dayEvents.filter(e => e.action === a.id);
    const done = todays.length > 0;
    const item = document.createElement('button');
    item.className = 'check-item' + (done ? ' done' : '');
    item.style.setProperty('--accent', a.color);
    item.innerHTML = `
      <span class="ci-emoji">${a.emoji}</span>
      <span class="ci-main">
        <span class="ci-name">${a.short || a.name}</span>
        ${done ? `<span class="ci-time">${hhmm(todays[0].ts)}</span>` : ''}
      </span>
      <span class="ci-check">✓</span>`;
    item.onclick = () => {
      if (done) openEditSheet(todays[0]);
      else { Store.add(a.id, {}, defaultTs()); toast(`✓ ${a.name}`); vibrate(); renderCurrent(); }
    };
    wrap.appendChild(item);
  });
}

function renderGrid() {
  const grid = document.getElementById('actionGrid');
  grid.innerHTML = '';
  const sleep = activeSleep();
  TILE_ACTIONS.forEach(a => {
    const btn = document.createElement('button');
    const active = a.id === 'sommeil' && !!sleep;
    btn.className = 'tile' + (active ? ' tile-active' : '');
    btn.style.setProperty('--tile-color', a.color);
    const badge = tileStat(a.id);
    btn.innerHTML = `
      <span class="emoji">${a.emoji}</span>
      <span class="name">${a.name}</span>
      ${badge ? `<span class="tile-badge">${badge}</span>` : ''}`;
    btn.addEventListener('click', () => onActionTap(a));
    grid.appendChild(btn);
  });
}

// Compteur du jour affiché sur une tuile — renvoie du HTML (2 valeurs empilées),
// '' = pas de badge :
//   tétée   → nb / durée totale
//   biberon → nb / quantité totale
//   couche  → 💧 pipi / 💩 caca (le "mixte" compte dans les deux)
//   sommeil → nb de siestes / durée totale
function tileStat(id) {
  const day = Store.byDay(selectedDate);
  const evs = act => day.filter(e => e.action === act);
  const lines = arr => arr.map(l => `<span>${l}</span>`).join('');

  if (id === 'tetee') {
    const list = evs('tetee');
    if (!list.length) return '';
    const dur = list.reduce((s, e) => s + (e.data && e.data.duration ? Number(e.data.duration) : 0), 0);
    return lines(dur ? [list.length, fmtDuration(dur)] : [list.length]);
  }
  if (id === 'biberon') {
    const list = evs('biberon');
    if (!list.length) return '';
    const ml = list.reduce((s, e) => s + (e.data && e.data.ml ? Number(e.data.ml) : 0), 0);
    return lines(ml ? [list.length, `${ml} ml`] : [list.length]);
  }
  if (id === 'couche') {
    const list = evs('couche');
    if (!list.length) return '';
    let pipi = 0, caca = 0;
    list.forEach(e => {
      const t = e.data && e.data.type;
      if (t === 'pipi' || t === 'mixte') pipi++;
      if (t === 'caca' || t === 'mixte') caca++;
    });
    if (!pipi && !caca) return lines([list.length]);   // couches sans type renseigné
    return lines([`💧 ${pipi}`, `💩 ${caca}`]);
  }
  if (id === 'sommeil') {
    // Découpe à minuit (Stats.sleepSegments) : un 22h30→02h compte 1h30 la veille
    // et 2h le lendemain, jamais 3h30 d'un seul côté.
    const segs = daySleepEntries(selectedDate).filter(e => e._seg);
    if (!segs.length) return '';
    const total = segs.reduce((s, e) => s + e._seg.min, 0);
    return lines([segs.length, fmtDuration(total)]);
  }
  return '';
}

function renderLearnedToday() {
  const ul = document.getElementById('learnedToday');
  ul.innerHTML = '';
  Store.byDay(selectedDate).filter(e => e.action === 'appris').forEach(ev => {
    const li = document.createElement('li');
    li.className = 'learned-item';
    li.innerHTML = `<span class="li-star">✨</span><span class="li-text">${escapeHtml(ev.data.text)}</span>`;
    li.onclick = () => openLearnedSheet(ev);
    ul.appendChild(li);
  });
}

/* Journal : dispatcher Liste / Frise (même journal d'événements, deux vues). */
function renderTimeline() {
  const listEl = document.getElementById('timeline');
  const friseEl = document.getElementById('timelineFrise');
  const count = document.getElementById('timelineCount');
  // Le journal exclut les "appris" (qui ont leur propre section + onglet) et
  // découpe les sommeils à minuit (cf. journalDisplayEvents).
  const events = journalDisplayEvents(selectedDate);
  const n = events.length;
  count.textContent = n ? `· ${n}` : '';
  document.querySelectorAll('#journalSeg button')
    .forEach(b => b.classList.toggle('active', b.dataset.view === journalView));
  hideJournalPop();
  if (journalView === 'timeline') {
    listEl.hidden = true; friseEl.hidden = false;
    renderJournalTimeline(friseEl, events);
  } else {
    friseEl.hidden = true; listEl.hidden = false;
    renderJournalList(listEl, events);
  }
}

/* Sommeils comptabilisés sur un jour donné, découpés à minuit (source unique
   pour le journal ET le badge de la tuile). Renvoie des COPIES de l'événement
   portant `_seg` = le segment de CE jour : l'id reste celui de l'épisode
   d'origine → l'édition modifie bien l'épisode entier, et la base ne contient
   toujours qu'un seul enregistrement (aucun doublon de données).
   Un 22h30→02h donne donc 1h30 la veille et 2h le lendemain.
   `_seg: null` = dodo non fermé/oublié : gardé visible le jour de sa saisie
   pour qu'on puisse le corriger, mais exclu des totaux. */
function daySleepEntries(date) {
  const dayMs = startOfDay(date).getTime();
  const nowMs = Date.now();
  const out = [];
  Store.all().forEach(e => {
    if (e.action !== 'sommeil') return;
    const segs = Stats.sleepSegments(e, nowMs);
    if (!segs.length) {
      if (ymd(new Date(e.ts)) === ymd(date)) out.push({ ...e, _seg: null });
      return;
    }
    const g = segs.find(x => x.dayMs === dayMs);
    if (g) out.push({ ...e, _seg: g });
  });
  return out;
}

/* Événements à AFFICHER dans le journal d'un jour : tout ce qui a été
   enregistré ce jour (hors "appris", qui a sa propre section) + les segments de
   sommeil du jour. Tri chronologique décroissant sur l'heure affichée. */
function journalDisplayEvents(date) {
  const out = Store.byDay(date)
    .filter(e => e.action !== 'appris' && e.action !== 'sommeil')
    .concat(daySleepEntries(date));
  const key = e => (e._seg ? e._seg.startMs : new Date(e.ts).getTime());
  return out.sort((a, b) => key(b) - key(a));
}

/* Vue LISTE (comportement historique : tap → édition complète). */
function renderJournalList(list, events) {
  list.innerHTML = '';
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'timeline-empty';
    li.textContent = 'Aucune action enregistrée ce jour.';
    list.appendChild(li);
    return;
  }
  events.forEach(ev => {
    const a = ACTION_MAP[ev.action] || { name: ev.action, emoji: '•', color: 'var(--line)' };
    let name = a.name, detail = describe(ev), time = hhmm(ev.ts);
    const g = ev.action === 'sommeil' ? ev._seg : null;
    if (g) {
      // Le libellé décrit le SEGMENT du jour (la durée que ce jour comptabilise),
      // et rappelle la durée de l'épisode entier quand il est à cheval sur minuit.
      const parts = [];
      if (g.contPrev) parts.push('commencé la veille');
      if (g.contNext) parts.push('continue le lendemain');
      name = parts.length ? `${a.name} · ${parts.join(' · ')}` : a.name;
      if (g.ongoing) {
        detail = `depuis ${hhmm(ev.ts)} · ${fmtDuration(g.min)}${g.contPrev ? ' ce jour' : ''} · en cours`;
      } else {
        // l'heure de début est déjà dans la colonne de droite → on ne la répète que
        // pour un segment venu de la veille (où la colonne porte l'heure de réveil)
        detail = (g.contPrev ? `${hhmm(g.startMs)} → ` : '→ ') + `${hhmm(g.endMs)} · ${fmtDuration(g.min)}`;
        if (g.contPrev || g.contNext) detail += ` · nuit de ${fmtDuration(g.totalMin)}`;
        time = g.contPrev ? hhmm(g.endMs) : hhmm(g.startMs);
      }
    }
    const li = document.createElement('li');
    li.className = 'event' + (g && g.contPrev ? ' cont' : '');
    li.innerHTML = `
      <div class="ev-dot" style="background:${a.color}33">${a.emoji}</div>
      <div class="ev-main">
        <div class="ev-name">${escapeHtml(name)}</div>
        ${detail ? `<div class="ev-detail">${escapeHtml(detail)}</div>` : ''}
      </div>
      <div class="ev-time">${time}</div>`;
    li.addEventListener('click', () => openEditSheet(ev));
    list.appendChild(li);
  });
}

/* Vue FRISE — axe horizontal 24 h en 2 bandes de 12 h, pistes par domaine.
   Lecture seule : tap sur une marque → popover d'info ancré (l'édition reste
   dans la vue Liste). */
function renderJournalTimeline(host, events) {
  host.innerHTML = '';
  if (!events.length) {
    host.innerHTML = '<div class="timeline-empty">Aucune action enregistrée ce jour.</div>';
    return;
  }
  const isToday = isSameDay(selectedDate, startOfDay(new Date()));
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const tl = document.createElement('div');
  tl.className = 'tl';
  JOURNAL_BANDS.forEach(band => tl.appendChild(renderJournalBand(band, events, { isToday, nowMin })));
  host.appendChild(tl);
}

/* Une bande = fenêtre de 12 h (0→12 ou 12→24). Minutes comptées depuis
   minuit du jour affiché (mn) → le sommeil à cheval sur minuit est borné
   proprement à 0/24, cohérent avec la découpe des stats. */
function renderJournalBand(band, events, { isToday, nowMin }) {
  const startMin = band.startH * 60, endMin = band.endH * 60, len = endMin - startMin;
  const p = (m) => ((m - startMin) / len) * 100;
  const dayStart = startOfDay(selectedDate).getTime();
  const mn = (ts) => Math.round((new Date(ts).getTime() - dayStart) / 60000);

  const wrap = document.createElement('div');
  wrap.className = 'tl-band';

  // Axe : graduations toutes les 2 h (suffixe "h")
  const axis = document.createElement('div');
  axis.className = 'tl-axis';
  let ax = '';
  for (let h = band.startH; h <= band.endH; h += 2) {
    const cls = h === band.startH ? 'start' : (h === band.endH ? 'end' : '');
    ax += `<div class="tl-tick ${cls}" style="left:${p(h * 60)}%">${h}h</div>`;
  }
  axis.innerHTML = ax;
  wrap.appendChild(axis);

  // Corps : overlay (nuit 20h→6h + grille + maintenant/futur) + pistes
  const body = document.createElement('div');
  body.className = 'tl-body';

  const overlay = document.createElement('div');
  overlay.className = 'tl-overlay';
  let ov = band.startH === 0
    ? `<div class="tl-night" style="left:0; width:${p(6 * 60)}%"></div>`     // 0→6 h
    : `<div class="tl-night" style="left:${p(20 * 60)}%; right:0"></div>`;   // 20→24 h
  for (let h = band.startH + 2; h < band.endH; h += 2) ov += `<div class="tl-gridline" style="left:${p(h * 60)}%"></div>`;
  if (isToday && nowMin > startMin && nowMin < endMin) {
    ov += `<div class="tl-future" style="left:${p(nowMin)}%"></div>`;
    ov += `<div class="tl-now" data-label="${pad2(Math.floor(nowMin / 60))}:${pad2(nowMin % 60)}" style="left:${p(nowMin)}%"></div>`;
  } else if (isToday && nowMin <= startMin) {
    ov += `<div class="tl-future" style="left:0; right:0"></div>`;          // bande entièrement future
  }
  overlay.innerHTML = ov;
  body.appendChild(overlay);

  JOURNAL_LANES.forEach((lane, i) => {
    const row = document.createElement('div');
    row.className = 'tl-lane' + (i % 2 ? ' alt' : '');
    const track = document.createElement('div');
    track.className = 'tl-track';

    events.filter(e => lane.actions.includes(e.action)).forEach(ev => {
      const a = ACTION_MAP[ev.action];
      if (!a) return;
      const start = mn(ev.ts);
      if (ev.action === 'sommeil') {
        const g = ev._seg;
        if (!g) return;                         // dodo oublié/non fermé : rien à tracer
        // Le segment est déjà borné au jour affiché → start ∈ [0,1440], end ∈ [0,1440].
        const segStart = mn(g.startMs), end = mn(g.endMs);
        const s = Math.max(segStart, startMin), e = Math.min(end, endMin);
        if (e <= s) return;                     // segment hors de cette bande
        const w = e - s;
        const bar = document.createElement('div');
        bar.className = 'tl-bar'
          + (g.ongoing ? ' ongoing' : '')
          + (g.contPrev ? ' cont-prev' : '')   // tronqué à minuit : vient de la veille
          + (g.contNext ? ' cont-next' : '');  // tronqué à minuit : continue demain
        bar.style.cssText = `--c:${a.color}; left:${p(s)}%; width:${(w / len) * 100}%`;
        // libellé = durée du SEGMENT (ce que ce jour comptabilise) dès > 1h, une seule
        // fois, dans la bande qui en contient la plus grande part
        const w1 = Math.max(0, Math.min(end, 720)  - Math.max(segStart, 0));
        const w2 = Math.max(0, Math.min(end, 1440) - Math.max(segStart, 720));
        const otherW = band.startH === 0 ? w2 : w1;
        const showHere = g.min > 60 && w > 0 && (w > otherW || (w === otherW && band.startH === 0));
        if (showHere) bar.innerHTML = `<span class="lbl">${fmtDuration(g.min)}</span>`;
        bar.addEventListener('click', (evt) => { evt.stopPropagation(); showJournalPop(ev, bar); });
        track.appendChild(bar);
      } else {
        if (start < startMin || start >= endMin) return;
        const pin = document.createElement('div');
        pin.className = 'tl-pin';
        pin.style.cssText = `--c:${a.color}; left:${p(start)}%`;
        pin.innerHTML = `<span class="em">${a.emoji}</span>`;
        pin.addEventListener('click', (evt) => { evt.stopPropagation(); showJournalPop(ev, pin); });
        track.appendChild(pin);
      }
    });

    row.appendChild(track);
    body.appendChild(row);
  });

  wrap.appendChild(body);
  return wrap;
}

/* ---------- Popover d'info de la frise (tap → info, re-tap → édition) ---------- */
let journalPopAnchor = null;
let journalPopEvent = null;
function popTime(ev) {
  if (ev.action === 'sommeil') {
    const g = ev._seg;                                   // bornes du segment de ce jour
    if (g && !g.ongoing) return `${hhmm(g.startMs)} → ${hhmm(g.endMs)}`;
    return `depuis ${hhmm(ev.ts)}`;
  }
  return hhmm(ev.ts);
}
function popDetail(ev) {
  const d = ev.data || {};
  switch (ev.action) {
    case 'tetee':       return d.side ? `Côté ${d.side}` + (d.duration ? ` · ${d.duration} min` : '') : '';
    case 'biberon':     return d.ml != null ? `${d.ml} ml` : '';
    case 'couche':      return d.type ? capitalize(d.type) : '';
    case 'temperature': return d.temp != null ? `${fmtTemp(d.temp)} °C` : '';
    case 'medicament':  return d.name || '';
    case 'sommeil': {
      const g = ev._seg;
      if (!g) return 'En cours…';
      const split = g.contPrev || g.contNext;
      return `Durée ${fmtDuration(g.min)}`
        + (split ? ` · nuit de ${fmtDuration(g.totalMin)}` : '')
        + (g.ongoing ? ' · en cours' : '');
    }
    default:            return '';
  }
}
function hideJournalPop() {
  const pop = document.getElementById('journalPop');
  if (!pop) return;
  pop.style.display = 'none';
  journalPopEvent = null;
  if (journalPopAnchor) { journalPopAnchor.classList.remove('selected'); journalPopAnchor = null; }
}
function showJournalPop(ev, anchor) {
  const pop = document.getElementById('journalPop');
  journalPopEvent = ev;
  const a = ACTION_MAP[ev.action] || { name: ev.action, emoji: '•', color: 'var(--line)' };
  const detail = popDetail(ev);
  pop.querySelector('.pop-body').innerHTML = `
    <div class="pop-row">
      <div class="pop-ic" style="background: color-mix(in srgb, ${a.color} 16%, #fff); border-color: ${a.color}">${a.emoji}</div>
      <div class="pop-txt">
        <div class="pop-name">${a.name}</div>
        <div class="pop-time">${popTime(ev)}</div>
      </div>
    </div>
    ${detail ? `<div class="pop-detail">${escapeHtml(detail)}</div>` : ''}`;

  // rendre visible pour mesurer, puis positionner (fixed, ancré à la marque)
  pop.style.display = 'block';
  pop.style.left = '0px'; pop.style.top = '0px';
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const gap = 10, margin = 8;
  const cx = r.left + r.width / 2;

  const above = r.top - ph - gap >= margin;     // au-dessus par défaut, bascule en dessous
  const top = above ? r.top - ph - gap : r.bottom + gap;
  pop.classList.toggle('above', above);
  pop.classList.toggle('below', !above);

  let left = cx - pw / 2;                        // centré sur la marque, borné à l'écran
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  const arrow = pop.querySelector('.pop-arrow');  // flèche pointe vers le centre de la marque
  const axp = Math.max(10, Math.min(cx - left, pw - 10));
  arrow.style.left = `${Math.round(axp - 5.5)}px`;
  arrow.style.right = 'auto';

  if (journalPopAnchor) journalPopAnchor.classList.remove('selected');
  journalPopAnchor = anchor; anchor.classList.add('selected');
}

/* ---------- Vue APPRIS ---------- */
function renderAppris() {
  document.body.classList.remove('other-day');
  const wrap = document.getElementById('apprisList');
  wrap.innerHTML = '';
  const items = Store.byAction('appris'); // triés du + récent au + ancien
  if (!items.length) {
    wrap.innerHTML = `<p class="appris-empty">Aucune nouveauté notée pour l'instant.<br>Ajoute la première depuis l'onglet Suivi 🍼</p>`;
    return;
  }
  let currentKey = null, dayBox = null;
  items.forEach(ev => {
    const d = new Date(ev.ts);
    const key = ymd(d);
    if (key !== currentKey) {
      currentKey = key;
      dayBox = document.createElement('div');
      dayBox.className = 'appris-day';
      const h = document.createElement('div');
      h.className = 'appris-date';
      h.textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      dayBox.appendChild(h);
      wrap.appendChild(dayBox);
    }
    const item = document.createElement('div');
    item.className = 'appris-item';
    item.innerHTML = `<span class="ai-star">✨</span><span class="ai-text">${escapeHtml(ev.data.text)}</span>`;
    item.onclick = () => openLearnedSheet(ev);
    dayBox.appendChild(item);
  });
}

/* ============================================================
   VUE STATS (onglet 📊)
   Consomme UNIQUEMENT la couche pure Stats.compute (toute la précision
   est là). Aucune donnée dérivée n'est stockée : tout est recalculé.
   ============================================================ */

/* ---------- Petits graphes SVG (charte dataviz appliquée) ----------
   viewBox uniforme (pas de distorsion), marques fines, extrémités arrondies
   ancrées à la ligne de base, écart de 2 px entre segments empilés.
   `null` dans un tableau = PAS de donnée (jamais un zéro) → aucune barre.
   `atten` = indices atténués (jour partiel : aujourd'hui / naissance). */
function topRounded(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  const f = n => n.toFixed(1);
  return `M${f(x)},${f(y + h)} L${f(x)},${f(y + r)} Q${f(x)},${f(y)} ${f(x + r)},${f(y)} `
       + `L${f(x + w - r)},${f(y)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)} L${f(x + w)},${f(y + h)} Z`;
}
/* Axe Y : borne haute « jolie » (1·1,5·2·3·4·5·7 × 10ⁿ) → graduations lisibles. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v))), nrm = v / pow;
  const steps = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
  let s = 10; for (const k of steps) { if (nrm <= k + 1e-9) { s = k; break; } }
  return s * pow;
}
/* Libellé d'axe compact pour une durée (minutes) : « 20m », « 1h30 », « 7h », « 14h ». */
function durAxis(min) {
  min = Math.round(min);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}
/* Borne haute « jolie » pour une durée (min) : valeur PAIRE → point milieu net
   (ex. 840 → 0 / 7h / 14h). Au-delà de la liste, arrondi au 12 h supérieur. */
function niceDurMax(min) {
  const steps = [20, 40, 60, 120, 180, 240, 360, 480, 600, 720, 840, 960, 1080, 1200, 1440];
  for (const s of steps) if (min <= s + 1e-9) return s;
  return Math.ceil(min / 720) * 720 || 20;
}
/* Échelle graduée à ~`target` intervalles réguliers (pas 1/2/5 ×10ⁿ) → renvoie
   {max, ticks}. Plusieurs lignes d'ordonnée régulières permettent de LIRE une
   barre sans étiquette (14/30 j) en la projetant entre deux graduations. */
function niceScale(dataMax, target = 4) {
  if (!(dataMax > 0)) return { max: 1, ticks: [0, 1] };
  const rough = dataMax / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / pow;
  // Pas entier ≥ 1 : les séries sont des comptages/volumes entiers → jamais de
  // graduation fractionnaire (ex. 0,5) ni d'étiquettes en double après arrondi.
  const step = Math.max(1, Math.round((n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow));
  const max = Math.ceil(dataMax / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(Math.round(v));
  return { max, ticks };
}
/* Idem pour une durée (min) mais avec des pas « ronds » en heures/demi-heures →
   libellés d'axe nets (0/3h/6h/… ou 0/30m/1h/1h30/2h). */
function niceDurScale(dataMax, target = 4) {
  const steps = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720];
  if (!(dataMax > 0)) return { max: 20, ticks: [0, 20] };
  const rough = dataMax / target;
  let step = steps[steps.length - 1];
  for (const s of steps) if (s >= rough) { step = s; break; }
  const max = Math.ceil(dataMax / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { max, ticks };
}
/* Valeur au-dessus d'une barre, affichée seulement si elle tient dans la cellule
   (sinon l'axe Y prend le relais — évite l'illisible sur 14/30 jours). */
function barValue(txt, cx, y, cellW, fill) {
  if (txt == null || txt === '' || txt.length * 4.9 > cellW - 1) return '';
  return `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="${fill || CHART.ink}" font-variant-numeric="tabular-nums">${txt}</text>`;
}

/* Barres simples avec axes (ordonnée graduée 0→max, abscisse = libellés jour). */
function statChartBars(values, o = {}) {
  const color = o.color || CHART.vert, W = o.W || 300, H = o.H || 66;
  const n = values.length || 1, atten = o.atten || new Set(), hasX = !!o.labels;
  const isDur = !!o.dur;
  const yfmt = isDur ? (v => v === 0 ? '0' : durAxis(v)) : (v => String(Math.round(v)));
  const dataMax = Math.max(...values.filter(v => v != null), 0);
  // Graduations régulières (0 → max en ~4 pas) : lire une barre sans étiquette en
  // la projetant entre deux lignes. midline:false → axe minimal 0/max (cartes compactes).
  let max, ticks;
  if (o.midline === false) {
    max = isDur ? niceDurMax(dataMax) : niceMax(dataMax);
    ticks = [0, max];
  } else {
    const sc = isDur ? niceDurScale(dataMax, o.ticks || 4) : niceScale(dataMax, o.ticks || 4);
    max = sc.max; ticks = sc.ticks;
  }
  const labelW = Math.max(...ticks.map(v => yfmt(v).length));
  const ML = o.ML != null ? o.ML : Math.max(16, Math.round(labelW * 5.6 + 5));   // marge Y auto-dimensionnée au libellé
  const MT = 10, MB = hasX ? 14 : 6;
  const plotW = W - ML, plotH = H - MT - MB, base = MT + plotH;
  const gap = n > 20 ? 1.2 : 2, bw = (plotW - gap * (n - 1)) / n, rx = Math.min(3, bw / 2);
  const xC = i => ML + i * (bw + gap) + bw / 2;
  const yAt = v => base - (max > 0 ? (v / max) * plotH : 0);
  let body = '';
  ticks.forEach(v => {
    const gy = yAt(v);
    body += `<line x1="${ML}" y1="${gy.toFixed(1)}" x2="${W}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}" stroke-width="1"${v !== 0 ? ' stroke-dasharray="3 3"' : ''}/>`;
    body += `<text x="${(ML - 3).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${CHART.ink}">${yfmt(v)}</text>`;
  });
  values.forEach((v, i) => {
    if (v == null || v <= 0) return;
    const x = ML + i * (bw + gap), h = Math.max(1.5, (v / max) * plotH);
    body += `<path d="${topRounded(x, base - h, bw, h, rx)}" fill="${color}"${atten.has(i) ? ' fill-opacity="0.38"' : ''}/>`;
    if (o.valfmt) body += barValue(o.valfmt(v), x + bw / 2, base - h - 2.5, bw + gap, CHART.ink);
  });
  if (hasX) o.labels.forEach((l, i) => { if (!l) return; const anc = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'); body += `<text x="${xC(i).toFixed(1)}" y="${(H - 3).toFixed(1)}" text-anchor="${anc}" font-size="8" fill="${CHART.ink}">${l}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${body}</svg>`;
}

/* Barres empilées sein (bas, orange) + biberon (haut, bleu) avec axes + compteurs. */
function statChartStacked(seinA, bibA, o = {}) {
  const W = o.W || 300, H = o.H || 90, n = seinA.length || 1, atten = o.atten || new Set(), hasX = !!o.labels;
  const totals = seinA.map((s, i) => (s == null && bibA[i] == null) ? null : (s || 0) + (bibA[i] || 0));
  const sc = niceScale(Math.max(...totals.filter(v => v != null), 0), o.ticks || 4);
  const max = sc.max, ticks = sc.ticks;
  const ML = o.ML != null ? o.ML : Math.max(16, Math.round(String(Math.round(max)).length * 5.6 + 5));
  const MT = 10, MB = hasX ? 14 : 6;
  const plotW = W - ML, plotH = H - MT - MB, base = MT + plotH, segGap = 2;
  const gap = n > 20 ? 1.2 : 2, bw = (plotW - gap * (n - 1)) / n, rx = Math.min(3, bw / 2);
  const xC = i => ML + i * (bw + gap) + bw / 2;
  const yAt = v => base - (max > 0 ? (v / max) * plotH : 0);
  let body = '';
  ticks.forEach(v => {
    const gy = yAt(v);
    body += `<line x1="${ML}" y1="${gy.toFixed(1)}" x2="${W}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}" stroke-width="1"${v !== 0 ? ' stroke-dasharray="3 3"' : ''}/>`;
    body += `<text x="${(ML - 3).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${CHART.ink}">${Math.round(v)}</text>`;
  });
  seinA.forEach((s0, i) => {
    if (s0 == null && bibA[i] == null) return;
    const s = s0 || 0, b = bibA[i] || 0, x = ML + i * (bw + gap), op = atten.has(i) ? ' fill-opacity="0.38"' : '';
    const sh = s > 0 ? (s / max) * plotH : 0, bh = b > 0 ? (b / max) * plotH : 0;
    let topLower = base;
    if (sh > 0) { body += `<rect x="${x.toFixed(1)}" y="${(base - sh).toFixed(1)}" width="${bw.toFixed(1)}" height="${sh.toFixed(1)}" fill="${CHART.sein}"${op}/>`; topLower = base - sh - segGap; }
    if (bh > 0) body += `<path d="${topRounded(x, topLower - bh, bw, bh, rx)}" fill="${CHART.biberon}"${op}/>`;
    if (bw >= 9) {   // compteurs dans les segments si la place le permet
      if (sh >= 10) body += `<text x="${(x + bw / 2).toFixed(1)}" y="${(base - sh / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${s}</text>`;
      if (bh >= 10) body += `<text x="${(x + bw / 2).toFixed(1)}" y="${(topLower - bh / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${b}</text>`;
    }
  });
  if (hasX) o.labels.forEach((l, i) => { if (!l) return; const anc = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'); body += `<text x="${xC(i).toFixed(1)}" y="${(H - 3).toFixed(1)}" text-anchor="${anc}" font-size="8" fill="${CHART.ink}">${l}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${body}</svg>`;
}

/* Courbe (%) avec axes gradués 0 / 50 / 100 + valeurs écrites sur la courbe.
   `every` = cadence des étiquettes, comptée EN PARTANT DU DERNIER JOUR (1 = tous
   les jours, 2 = un jour sur deux, 5 = un jour sur cinq) : la valeur du jour le
   plus récent est donc toujours écrite, et l'espacement reste constant quelle que
   soit la période. L'unité (« % ») n'est écrite qu'une fois, sur ce dernier point. */
function statChartLine(values, o = {}) {
  const W = o.W || 300, H = o.H || 78, n = values.length || 1, color = o.color || CHART.biberon, max = o.max || 100;
  const hasX = !!o.labels, ML = o.ML != null ? o.ML : 22, MR = 8, MT = 10, MB = hasX ? 14 : 6;
  const plotW = W - ML - MR, plotH = H - MT - MB, gx2 = W - MR;
  const xAt = i => ML + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = v => MT + plotH - (Math.min(v, max) / max) * plotH;
  let body = '';
  // Repères intermédiaires 25/75 : pointillés discrets, sans étiquette (aide à projeter).
  [25, 75].forEach(gv => {
    const gy = yAt(gv);
    body += `<line x1="${ML}" y1="${gy.toFixed(1)}" x2="${gx2.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}" stroke-width="1" stroke-dasharray="2 3"/>`;
  });
  [0, 50, 100].forEach(gv => {
    const gy = yAt(gv);
    body += `<line x1="${ML}" y1="${gy.toFixed(1)}" x2="${gx2.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}" stroke-width="1"${gv === max ? ' stroke-dasharray="3 3"' : ''}/>`;
    body += `<text x="${(ML - 3).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${CHART.ink}">${gv}</text>`;
  });
  let seg = [];
  const flush = () => {
    if (seg.length > 1) body += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    else if (seg.length === 1) { const [x, y] = seg[0].split(','); body += `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>`; }
    seg = [];
  };
  values.forEach((v, i) => { if (v == null) flush(); else seg.push(`${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`); });
  flush();
  let li = -1; for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) { li = i; break; }
  const every = Math.max(1, Math.round(o.every || 0));
  // Étiquettes intermédiaires : au-dessus du point, ou dessous quand le point est
  // trop haut pour que le texte tienne dans le cadre (0 % et 100 % existent).
  if (o.every) for (let i = li - every; i >= 0; i -= every) {
    if (values[i] == null) continue;   // pas de donnée → pas d'étiquette (jamais un 0 inventé)
    const x = xAt(i), y = yAt(values[i]), haut = y - MT < 11;
    body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${color}"/>`;
    body += `<text x="${x.toFixed(1)}" y="${(haut ? y + 10 : y - 5).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="${color}" font-variant-numeric="tabular-nums">${Math.round(values[i])}</text>`;
  }
  if (li >= 0) {
    const x = xAt(li), y = yAt(values[li]), haut = y - MT < 12;
    body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`;
    body += `<text x="${(x - 5).toFixed(1)}" y="${(haut ? y + 11 : y - 6).toFixed(1)}" text-anchor="end" font-size="10" font-weight="700" fill="${color}">${Math.round(values[li])} %</text>`;
  }
  if (hasX) o.labels.forEach((l, i) => { if (!l) return; const anc = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'); body += `<text x="${xAt(i).toFixed(1)}" y="${(H - 3).toFixed(1)}" text-anchor="${anc}" font-size="8" fill="${CHART.ink}">${l}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${body}</svg>`;
}

/* Série de durées sur une échelle TRONQUÉE (sommeil total : 8 h → 20 h, une
   journée de bébé ne sort jamais de cette bande) : 12 h d'amplitude au lieu de
   18 h, donc une lecture bien plus fine.
   Une échelle qui ne part pas de zéro interdit la barre — sa longueur ne serait
   plus proportionnelle à la valeur (le biais de lecture classique des « barres
   tronquées »). La valeur est donc encodée par une POSITION : un point par jour,
   relié par une ligne fine. Un jour hors bande (le jour en cours, encore sous le
   plancher) est ramené sur la bordure et dessiné en cercle CREUX, et la ligne
   s'y interrompt : « hors échelle » se voit, aucun faux niveau n'est tracé. */
function statChartBand(values, o = {}) {
  const color = o.color || CHART.vert, W = o.W || 150, H = o.H || 74;
  const n = values.length || 1, atten = o.atten || new Set(), hasX = !!o.labels;
  const min = o.min || 0, max = o.max || 1440, step = o.step || 240;
  const ticks = []; for (let v = min; v <= max + 1e-6; v += step) ticks.push(v);
  const labelW = Math.max(...ticks.map(v => durAxis(v).length));
  const ML = o.ML != null ? o.ML : Math.max(16, Math.round(labelW * 5.6 + 5));
  const MT = 8, MB = hasX ? 14 : 6, MR = 4;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const xAt = i => ML + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = v => MT + plotH - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * plotH;
  const dedans = v => v != null && v >= min && v <= max;
  const r = n > 20 ? 1.7 : (n > 10 ? 2.2 : 2.8);
  let body = '';
  ticks.forEach(v => {
    const gy = yAt(v);
    body += `<line x1="${ML}" y1="${gy.toFixed(1)}" x2="${W}" y2="${gy.toFixed(1)}" stroke="${CHART.grid}" stroke-width="1"${(v === min || v === max) ? '' : ' stroke-dasharray="3 3"'}/>`;
    body += `<text x="${(ML - 3).toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="${CHART.ink}">${durAxis(v)}</text>`;
  });
  let seg = [];
  const flush = () => {
    if (seg.length > 1) body += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.5"/>`;
    seg = [];
  };
  values.forEach((v, i) => { if (dedans(v)) seg.push(`${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`); else flush(); });
  flush();
  values.forEach((v, i) => {
    if (v == null) return;
    const x = xAt(i).toFixed(1), y = yAt(v).toFixed(1), op = atten.has(i) ? ' opacity="0.45"' : '';
    body += dedans(v)
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"${op}/>`
      : `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${color}" stroke-width="1.4"${op}/>`;
  });
  if (hasX) o.labels.forEach((l, i) => { if (!l) return; const anc = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'); body += `<text x="${xAt(i).toFixed(1)}" y="${(H - 3).toFixed(1)}" text-anchor="${anc}" font-size="8" fill="${CHART.ink}">${l}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${body}</svg>`;
}

/* ---------- Rendu de la vue ---------- */
const WK = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
/* Libellés d'abscisse adaptés à la période : lettre du jour à 7 j ; au-delà,
   date calendaire jj/mm espacée (dernier jour toujours affiché, pas de collision). */
function xLabels(days, period) {
  if (period <= 7) return days.map(d => WK[d.date.getDay()]);
  const n = days.length, fmt = d => `${d.getDate()}/${d.getMonth() + 1}`;
  const every = period <= 14 ? 3 : 6;
  const keep = new Set();
  for (let i = n - 1; i >= 0; i -= every) keep.add(i);   // aligné sur le dernier jour
  return days.map((d, i) => keep.has(i) ? fmt(d.date) : '');
}
function renderStats() {
  document.body.classList.remove('other-day');
  const host = document.getElementById('view-stats');
  if (!host) return;

  const hasAny = Store.all().some(e => e.action !== 'appris');
  if (!hasAny) {
    host.innerHTML = `<header class="view-header"><h1>📊 Statistiques</h1></header>
      <p class="appris-empty">Pas encore de données à analyser.<br>Enregistre des tétées, biberons, couches… depuis l'onglet Suivi.</p>`;
    return;
  }

  const s = Stats.compute(Store.all(), {
    periodDays: statsPeriod,
    domainStart: DATA_START,
    firstCompleteDay: FIRST_COMPLETE_DAY,
  });
  const days = s.days, today = s.today || {};
  const labels = xLabels(days, statsPeriod);

  // Formatage (précis : 1 décimale pour moyennes, virgule française)
  const f0 = x => x == null ? '—' : Math.round(x).toString();
  const f1 = x => x == null ? '—' : (Math.round(x * 10) / 10).toString().replace('.', ',');
  const pct = x => x == null ? '—' : Math.round(x) + ' %';
  const dur = x => x == null ? '—' : fmtDuration(Math.round(x));
  const durLong = x => x == null ? '—' : (x >= 1440 ? `${Math.floor(x / 1440)} j ${Math.floor((x % 1440) / 60)} h` : fmtDuration(Math.round(x)));

  // Séries par jour — `null` avant la fiabilité du domaine (jamais un faux zéro)
  const seinA = days.map(d => d.dataRepas ? d.tetees : null);
  const bibA = days.map(d => d.dataRepas ? d.biberons : null);
  const shareA = days.map(d => (d.dataRepas && d.repas > 0) ? Math.round(d.bottleShare * 100) : null);
  const volA = days.map(d => d.dataRepas ? d.volumeMl : null);
  const teteeDurA = days.map(d => d.dataRepas ? d.teteeDurMin : null);
  const sleepA = days.map(d => d.dataSommeil ? d.sleepMin : null);
  const longA = days.map(d => d.dataSommeil ? d.longestSleepMin : null);
  const pipiA = days.map(d => d.dataCouche ? d.pipis : null);
  const cacaA = days.map(d => d.dataCouche ? d.cacas : null);

  // Atténuation : jours partiels (aujourd'hui / naissance) ayant des données
  const attSet = flag => new Set(days.map((d, i) => (!d.complete && d[flag]) ? i : -1).filter(i => i >= 0));
  const attFeeds = attSet('dataRepas'), attCouche = attSet('dataCouche'), attSleep = attSet('dataSommeil');

  const av = s.averages, pe = s.period;
  const periodBtns = [7, 14, 30].map(p =>
    `<button class="per-btn${statsPeriod === p ? ' active' : ''}" data-p="${p}">${p} j</button>`).join('');

  // Bandeau "Aujourd'hui" (jour partiel — valeurs brutes à cette heure, sans moyenne trompeuse)
  const todayShare = today.repas > 0 ? Math.round(today.bottleShare * 100) + ' %' : '—';
  const banner = `
    <div class="today-banner">
      <div class="tb-title">Aujourd'hui <span>· à cette heure</span></div>
      <div class="tb-chips">
        <div class="tb-chip"><span class="tb-v">${f0(today.repas)}</span><span class="tb-l">repas</span></div>
        <div class="tb-chip"><span class="tb-v">${todayShare}</span><span class="tb-l">biberon</span></div>
        <div class="tb-chip"><span class="tb-v">${dur(today.sleepMin)}</span><span class="tb-l">sommeil</span></div>
        <div class="tb-chip"><span class="tb-v">${f0(today.pipis)}/${f0(today.cacas)}</span><span class="tb-l">💧/💩</span></div>
      </div>
    </div>`;

  const legendFeeds = `<div class="sc-legend"><span class="lg"><i style="background:${CHART.sein}"></i>Sein</span><span class="lg"><i style="background:${CHART.biberon}"></i>Biberon</span></div>`;
  const card = (o) => `
    <div class="stat-card${o.wide ? ' stat-card-wide' : ''}">
      <div class="sc-head"><div class="sc-title">${o.title}</div>${o.legend || ''}</div>
      <div class="sc-hero">${o.hero}${o.sub ? `<span class="sc-sub">${o.sub}</span>` : ''}</div>
      <div class="sc-chart">${o.chart}</div>
    </div>`;

  const cards = [
    card({ // 1 ★ Sein vs Biberon
      wide: true, title: 'Sein vs Biberon', legend: legendFeeds,
      hero: `${f1(av.repas)}`, sub: 'repas / j',
      chart: statChartStacked(seinA, bibA, { atten: attFeeds, labels, W: 300, H: 92 }),
    }),
    card({ // 2 ★ Part du biberon
      wide: true, title: 'Part du biberon', hero: pct(pe.bottleShare == null ? null : pe.bottleShare * 100),
      sub: 'du lait donné au biberon',
      // Cadence des étiquettes : 7 j → chaque jour, 14 j → 1/2, 30 j → 1/5.
      chart: statChartLine(shareA, { color: CHART.biberon, labels, W: 300, H: 80, every: statsPeriod <= 7 ? 1 : (statsPeriod <= 14 ? 2 : 5) }),
    }),
    card({ // 3 Volume bu (biberon, bleu)
      title: 'Volume bu', hero: `${f0(av.volumeMl)}`, sub: 'ml / j (biberon)',
      chart: statChartBars(volA, { color: CHART.biberon, atten: attFeeds, labels, W: 150, H: 74, valfmt: v => String(v) }),
    }),
    card({ // 4 Temps au sein (tétées, orange) — en face du volume biberon
      title: 'Temps au sein', hero: dur(av.teteeDurMin), sub: '/ j (tétées)',
      chart: statChartBars(teteeDurA, { color: CHART.sein, atten: attFeeds, labels, W: 150, H: 74, dur: true }),
    }),
    card({ // 5 Sommeil total — échelle tronquée 8 h → 20 h (bande jamais dépassée)
      title: 'Sommeil', hero: dur(av.sleepMin), sub: '/ j',
      chart: statChartBand(sleepA, { color: CHART.vert, atten: attSleep, labels, W: 150, H: 74, min: 480, max: 1200, step: 240 }),
    }),
    card({ // 6 Plus long sommeil
      title: 'Plus long sommeil', hero: dur(av.longestSleepMin), sub: '/ j en moyenne',
      chart: statChartBars(longA, { color: CHART.vert, atten: attSleep, labels, W: 150, H: 74, dur: true }),
    }),
    card({ // 7 Pipis & Cacas
      wide: true, title: 'Pipis & Cacas',
      hero: `<span class="sc-duo">💧 ${f1(av.pipis)}</span><span class="sc-duo">💩 ${f1(av.cacas)}</span>`,
      sub: '/ j en moyenne',
      chart: `<div class="sc-row"><span class="sc-rowlab">💧 Pipis</span>${statChartBars(pipiA, { color: CHART.vert, atten: attCouche, W: 232, H: 50, ML: 14, midline: false, valfmt: v => String(v) })}</div>
              <div class="sc-row sc-row-sep"><span class="sc-rowlab">💩 Cacas</span>${statChartBars(cacaA, { color: CHART.vert, atten: attCouche, W: 232, H: 50, ML: 14, midline: false, valfmt: v => String(v) })}</div>`,
    }),
  ].join('');

  // Détails (repliés)
  const medsHtml = pe.meds.length
    ? pe.meds.map(m => `<div class="dt-med">${escapeHtml(m.name)} · ${new Date(m.ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${hhmm(m.ts)}</div>`).join('')
    : '<span class="dt-v">—</span>';
  const detailRow = (label, value) => `<div class="dt-row"><span class="dt-l">${label}</span><span class="dt-v">${value}</span></div>`;
  const details = `
    <details class="stat-details">
      <summary>Détails</summary>
      ${detailRow('Intervalle moyen entre repas', dur(pe.avgFeedGapMin))}
      ${detailRow('Plus long intervalle entre 2 repas', dur(pe.longestFeedGapMin))}
      ${detailRow('Durée de tétée moyenne', pe.avgTeteeDurationMin == null ? '—' : pe.avgTeteeDurationMin + ' min')}
      ${detailRow('Équilibre des côtés', pe.sideLeftPct == null ? '—' : `G ${pe.sideLeftPct} % · D ${pe.sideRightPct} %`)}
      ${detailRow('Intervalle moyen entre 2 cacas', durLong(pe.avgPoopGapMin))}
      ${detailRow('Température max', pe.tempMax == null ? '—' : `${fmtTemp(pe.tempMax)} °C${pe.tempAlert ? ' ⚠️' : ''}`)}
      ${detailRow('Bains', pe.bains)}
      <div class="dt-row dt-col"><span class="dt-l">Médicaments</span><div class="dt-meds">${medsHtml}</div></div>
    </details>`;

  // Qualité des données
  const byId = {}; Store.all().forEach(e => { byId[e.id] = e; });
  const qTypes = [
    ['couchesSansType', '🧷', 'Couche sans contenu'],
    ['teteesSansCote', '🤱', 'Tétée sans côté'],
    ['dodosNonFermes', '😴', 'Dodo non terminé'],
    ['dureesNegatives', '⏱️', 'Durée négative (réveil avant coucher)'],
    ['dureesAberrantes', '⏱️', 'Dodo de durée improbable (> 16 h)'],
    ['dodosChevauchants', '😴', 'Dodo qui chevauche le précédent'],
    ['tempHorsPlage', '🌡️', 'Température hors plage'],
  ];
  let qRows = '', qCount = 0;
  qTypes.forEach(([key, emoji, label]) => {
    (s.quality[key] || []).forEach(id => {
      const e = byId[id]; if (!e) return;
      const when = new Date(e.ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + hhmm(e.ts);
      qCount++;
      qRows += `<button class="q-row" data-id="${id}"><span class="q-emoji">${emoji}</span><span class="q-lab">${label}</span><span class="q-when">${when} ›</span></button>`;
    });
  });
  const quality = qRows
    ? `<details class="quality-box"><summary>⚠️ Qualité des données<span class="qb-count">${qCount}</span></summary><div class="qb-sub">Corrige une saisie incomplète en la touchant</div>${qRows}</details>`
    : '';

  const exportBox = `
    <div class="export-box">
      <div class="eb-title">Export</div>
      <div class="eb-sub">Pour analyse / IA — données exhaustives</div>
      <div class="eb-btns">
        <button class="eb-btn" id="expJson">JSON brut</button>
        <button class="eb-btn" id="expEvents">CSV événements</button>
        <button class="eb-btn" id="expDaily">CSV /jour</button>
      </div>
    </div>`;

  host.innerHTML = `
    <header class="view-header"><h1>📊 Statistiques</h1></header>
    <div class="period-sel">${periodBtns}</div>
    ${banner}
    <div class="stat-grid">${cards}</div>
    ${details}
    ${quality}
    ${exportBox}`;

  // Câblage
  host.querySelectorAll('.per-btn').forEach(b => b.onclick = () => { statsPeriod = Number(b.dataset.p); renderStats(); });
  host.querySelectorAll('.q-row').forEach(b => b.onclick = () => { const e = byId[b.dataset.id]; if (e) openEditSheet(e); });
  const j = host.querySelector('#expJson'); if (j) j.onclick = exportJSON;
  const ce = host.querySelector('#expEvents'); if (ce) ce.onclick = exportEventsCSV;
  const cd = host.querySelector('#expDaily'); if (cd) cd.onclick = exportDailyCSV;
}

/* ============================================================
   Vue PRÉDICTION — RECOS-prediction-sommeil-v5.md §3.4 → §3.9
   ------------------------------------------------------------
   Mode laboratoire assumé : on affiche TOUT dès le 1er point de donnée, avec
   deux informations toujours SÉPARÉES à côté de chaque chiffre —
     · le RECUL      : 🌱/🧪/✅ + n (combien de mesures / de backtests) ;
     · la PERFORMANCE : erreur médiane et P80 des backtests.
   Ce qui n'apparaît jamais : un pourcentage de confiance, une plage obtenue en
   additionnant deux intervalles sans le dire, un état vide alors qu'une donnée
   existe, ou une notification (tout reste dans cet onglet).
   Recalcul lourd au SEUL affichage de l'onglet (§3.7) ; le timer de 60 s ne
   rafraîchit que la ligne relative à « maintenant ».
   ============================================================ */
const PRED_TIERS = [
  { emoji: '🌱', text: 'peu de recul' },
  { emoji: '🧪', text: 'recul intermédiaire' },
  { emoji: '✅', text: 'recul important' },
];
// Badge de RECUL (jamais de confiance) — dérivé du même n que le chiffre affiché.
function tierBadge(n, emerging = 20, solid = 40) {
  const t = n >= solid ? PRED_TIERS[2] : (n >= emerging ? PRED_TIERS[1] : PRED_TIERS[0]);
  return { emoji: t.emoji, text: `${t.text} (n=${n})` };
}
// Heure d'horloge + repère de jour quand l'estimation franchit minuit.
function predClock(ms, refMs) {
  const d = new Date(ms), t = hhmm(d);
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(new Date(refMs)).getTime()) / 86400000);
  if (diff === 0) return t;
  if (diff === 1) return `${t} (+1j)`;
  if (diff === -1) return `${t} (hier)`;
  return `${t} (${d.getDate()}/${d.getMonth() + 1})`;
}
const plural = (n, s = 's') => n > 1 ? s : '';
// Écart signé : + = plus tard que prévu (même convention que les résidus de stats.js)
function predSigned(min) {
  const r = Math.round(min);
  return `${r > 0 ? '+' : (r < 0 ? '−' : '±')}${Math.abs(r)} min`;
}
// Performance d'un backtest — toujours sur sa propre ligne, jamais fondue dans le badge.
function predPerfLine(q, label) {
  if (!q.n) return `Performance ${label} : aucun backtest encore (n=0).`;
  return `Performance ${label} : erreur médiane ${Math.round(q.medAbsMin)} min · 80 % ≤ ${Math.round(q.p80AbsMin)} min · ${q.recentN} backtest${plural(q.recentN)} récent${plural(q.recentN)}.`;
}

/* Ligne d'état relative à MAINTENANT (seule partie rafraîchie chaque minute). */
function predRelHTML(p) {
  const since = p.sinceMs == null ? null : fmtDuration(Math.round((Date.now() - p.sinceMs) / 60000));
  if (p.state === 'ASLEEP') {
    const head = `💤 Endormi depuis ${hhmm(p.sinceMs)} · ${since}`;
    if (p.wake && p.wake.hiMs != null && Date.now() > p.wake.hiMs) {
      // Pas de « en retard » : ce n'est pas un rendez-vous manqué (§3.9).
      return `${head} — au-delà de la plage habituelle observée.`;
    }
    return p.wake ? `${head} — réveil estimé vers ${predClock(p.wake.atMs, p.nowMs)}.` : `${head}.`;
  }
  if (p.state === 'AWAKE') {
    const head = `☀️ Éveillé depuis ${hhmm(p.sinceMs)} · ${since}`;
    if (!p.onset || p.onset.atMs == null) return `${head}.`;
    const d = Math.round((p.onset.atMs - Date.now()) / 60000);
    if (d > 0) return `${head} — endormissement estimé dans ${fmtDuration(d)}.`;
    if (d === 0) return `${head} — endormissement estimé maintenant.`;
    return `${head} — l'heure estimée est passée de ${fmtDuration(-d)} (une habitude observée, pas un rendez-vous).`;
  }
  return 'Aucun dodo enregistré pour l\'instant.';
}
let predLast = null;                        // dernière prédiction rendue (pour le tic de 60 s)
function refreshPredictionRel() {
  const el = document.getElementById('predRel');
  if (el && predLast) el.innerHTML = predRelHTML(predLast);
}

/* Bloc 🌙 endormissement : dernier réveil + médiane des écarts d'éveil. */
function predOnsetBlock(p) {
  if (p.state === 'ASLEEP') {
    return `<div class="est-empty">Bébé dort en ce moment : l'endormissement n'est plus une estimation, il est mesuré à <b>${hhmm(p.sinceMs)}</b>.</div>`;
  }
  if (!p.onset.n || p.onset.atMs == null) {
    return `<div class="est-empty">Aucun écart d'éveil mesuré encore (n=0) — rien à estimer pour l'instant. Il faut deux dodos terminés à la suite pour en obtenir un.</div>`;
  }
  const t = tierBadge(p.onset.n), med = fmtDuration(Math.round(p.onset.medianMin));
  const range = p.onset.loMs != null
    ? `Le plus souvent entre <b>${predClock(p.onset.loMs, p.nowMs)}</b> et <b>${predClock(p.onset.hiMs, p.nowMs)}</b> (≈ ${med} d'éveil).`
    : `≈ ${med} d'éveil — ${p.onset.n === 1 ? 'une seule mesure' : `${p.onset.n} mesures seulement`}, pas encore de plage possible (dès n=${Stats.WW_MIN_SAMPLES_FOR_RANGE}).`;
  return `
    <div class="est-hero">${predClock(p.onset.atMs, p.nowMs)} <small>endormissement</small> <span class="badge-chip">${t.emoji}</span></div>
    <div class="est-range">${range}</div>
    <div class="est-n">${t.emoji} ${t.text} · basé sur ${p.onset.n} écart${plural(p.onset.n)} d'éveil récent${plural(p.onset.n)} — expérimental, à prendre avec précaution.<br>${predPerfLine(p.quality1, 'du prédicteur d’endormissement')}</div>`;
}

/* Bloc 🌅 réveil : chaîné sur l'endormissement (éveillé) ou ancré sur
   l'endormissement RÉEL (endormi). La plage n'additionne jamais deux
   intervalles sans le dire (§3.4). */
function predWakeBlock(p) {
  if (!p.wake) {
    if (p.state === 'AWAKE' && !p.onset.n && p.duration.n) {
      return `<div class="est-empty">Il faut d'abord un écart d'éveil mesuré pour chaîner une heure de réveil. Les durées de sommeil, elles, sont déjà là (n=${p.duration.n}).</div>`;
    }
    return `<div class="est-empty">Aucune durée de sommeil mesurée encore (n=0) — rien à estimer pour l'instant.</div>`;
  }
  const w = p.wake, t = tierBadge(p.duration.n);
  const med = `≈ ${fmtDuration(Math.round(p.duration.medianMin))} de sommeil`;
  const wide = p.duration.wide
    ? ` <b>⚠️ plage large</b> : à cet âge, la durée de sommeil mélange siestes courtes et nuits longues — prends ça comme un ordre de grandeur, pas une promesse.`
    : '';
  const bornes = `entre <b>${w.loMs == null ? '—' : predClock(w.loMs, p.nowMs)}</b> et <b>${w.hiMs == null ? '—' : predClock(w.hiMs, p.nowMs)}</b>`;
  let range;
  if (w.loMs == null && p.duration.p25Min == null) {
    range = `${med} — ${p.duration.n === 1 ? 'une seule mesure' : `${p.duration.n} mesures seulement`}, pas encore de plage possible (dès n=${Stats.SD_MIN_SAMPLES_FOR_RANGE}).`;
  } else if (w.loMs == null) {
    // Les durées ont déjà leur plage, mais le réveil part de l'endormissement ESTIMÉ :
    // sans plage d'endormissement ni aller-retour vérifié, impossible de l'encadrer honnêtement.
    range = `${med} — pas encore de plage : le réveil part de l'endormissement estimé, et il manque des écarts d'éveil pour l'encadrer (n=${p.onset.n}, plage dès n=${Stats.WW_MIN_SAMPLES_FOR_RANGE}).`;
  } else if (w.basis === 'roundtrip') {
    const rt = tierBadge(p.roundtrip.n);
    // La plage est corrigée du biais signé : elle peut donc se retrouver
    // entièrement d'un côté du point brut. C'est voulu (§3.4) — mais il faut le dire,
    // sinon un chiffre hors de sa propre plage passe pour un bug.
    const biais = (w.atMs < w.loMs || w.atMs > w.hiMs)
      ? ` L'heure ci-dessus est le point brut du chaînage ; la plage, elle, est corrigée du décalage constaté (les réveils réels tombent régulièrement plus ${w.atMs < w.loMs ? 'tard' : 'tôt'} que ce point) — c'est la plage qu'il faut regarder.`
      : '';
    range = `Le plus souvent ${bornes} (${med}). ${rt.emoji} plage calibrée sur ${p.roundtrip.n} réveil${plural(p.roundtrip.n)} déjà prévu${plural(p.roundtrip.n)} puis observé${plural(p.roundtrip.n)}.${biais}${wide}`;
  } else if (w.basis === 'somme') {
    range = `Environ ${bornes} (${med}) — <i>approximation grossière</i> : somme des deux plages, faute d'aller-retour déjà vérifié (n=0). Elle sera remplacée dès le premier réveil prévu puis observé.${wide}`;
  } else {
    range = `Le plus souvent ${bornes} d'après les durées récentes (${med}).${wide}`;
  }
  const foot = p.state === 'ASLEEP'
    ? `${t.emoji} ${t.text} · calé sur l'endormissement RÉEL de ${hhmm(p.sinceMs)}.<br>${predPerfLine(p.quality2, 'du prédicteur de durée')}`
    : `${t.emoji} ${t.text} · chaîné à partir de l'endormissement estimé — jamais une addition de deux plages pour le point central.<br>${predPerfLine(p.roundtrip, 'de la chaîne complète')}`;
  return `
    <div class="est-hero">${predClock(w.atMs, p.nowMs)} <small>réveil</small> <span class="badge-chip">${t.emoji}</span></div>
    <div class="est-range">${range}</div>
    <div class="est-n">${foot}</div>`;
}

/* Carte « Qualité du backtest » : le chiffre, son badge, ses barres d'erreur. */
function predQualityCard(title, q, o = {}) {
  if (!q.n) {
    return `
      <div class="stat-card${o.wide ? ' stat-card-wide' : ''}">
        <div class="sc-head"><div class="sc-title">${title}</div></div>
        <div class="est-hero">—</div>
        <div class="est-range">Aucun backtest encore (n=0). ${o.why || ''}</div>
      </div>`;
  }
  const t = tierBadge(q.n);
  // Emplacements réservés d'avance (comblés par des null, ignorés au tracé) : sans ça,
  // 2 backtests donnent 2 barres larges d'un demi-graphe. Les barres poussent
  // vers la droite au fil des backtests.
  const slots = o.wide ? 14 : 8;
  const errs = q.absErrs.map(v => Math.round(v));
  while (errs.length < slots) errs.push(null);
  return `
    <div class="stat-card${o.wide ? ' stat-card-wide' : ''}">
      <div class="sc-head"><div class="sc-title">${title}</div></div>
      <div class="est-hero">${Math.round(q.medAbsMin)} min <small>d'écart médian</small> <span class="badge-chip">${t.emoji}</span></div>
      <div class="est-range">80 % des prédictions à ± ${Math.round(q.p80AbsMin)} min · ${q.recentN} backtest${plural(q.recentN)} récent${plural(q.recentN)} · ${t.text}.</div>
      <div class="sc-chart">${statChartBars(errs, { color: CHART.biberon, W: o.wide ? 300 : 150, H: 74, ticks: 3, valfmt: v => String(v) })}</div>
      ${o.note ? `<div class="sd-note">${o.note}</div>` : ''}
    </div>`;
}

/* Tableau « Prédiction vs réalité » — les 8 derniers backtests, du + récent au + ancien. */
function predTableCard(title, label, q) {
  if (!q.rows.length) {
    return `
      <div class="stat-card stat-card-wide">
        <div class="sc-head"><div class="sc-title">${title}</div></div>
        <div class="pred-table-empty">Aucune prédiction backtestée encore (n=0).</div>
      </div>`;
  }
  const rows = q.rows.slice(-8).reverse().map(r => {
    const cls = Math.abs(r.errMin) <= 15 ? 'err-ok' : 'err-mid';
    // Le jour affiché est celui de l'heure PRÉVUE ; le réel porte un repère
    // de jour s'il tombe de l'autre côté de minuit (sinon 23:15 → 06:30 se lit à l'envers).
    const jour = new Date(r.predMs).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    return `<tr><td>${jour} · ${hhmm(r.predMs)}</td><td>${predClock(r.realMs, r.predMs)}</td><td class="${cls}">${predSigned(r.errMin)}</td></tr>`;
  }).join('');
  return `
    <div class="stat-card stat-card-wide">
      <div class="sc-head"><div class="sc-title">${title}</div></div>
      <table class="pred-table">
        <thead><tr><th>${label} prévu</th><th>Réel</th><th>Écart</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="est-n">Écart = réel − prévu (+ = plus tard que prévu). Chaque ligne n'utilise que les mesures connues AVANT elle.</div>
    </div>`;
}

function renderPrediction() {
  document.body.classList.remove('other-day');
  const host = document.getElementById('view-prediction');
  if (!host) return;

  const p = Stats.sleepPrediction(Store.all(), { domainStart: DATA_START, birth: BIRTH });
  predLast = p;
  const cx = p.context, ex = cx.excluded;
  const ctxRow = (l, v) => `<div class="ctx-row"><span class="cr-label">${l}</span><span class="cr-val">${v}</span></div>`;
  const nVal = n => `n=${n} ${tierBadge(n).emoji}`;

  const contexte = `
    <div class="stat-card stat-card-wide">
      <div class="sc-head"><div class="sc-title">Contexte</div></div>
      <div class="ctx-list">
        <div class="ctx-group">
          <div class="ctx-group-title">Commun aux deux prédicteurs</div>
          ${ctxRow('Âge du bébé', cx.ageDays == null ? '—' : `${cx.ageDays} j`)}
          ${ctxRow('Jours de sommeil suivis', `${cx.trackedSleepDays} j`)}
          ${ctxRow('Dodos retenus', cx.episodesN)}
          ${ex.aberrants ? ctxRow('Dodos improbables écartés', ex.aberrants) : ''}
          ${ex.chevauchants ? ctxRow('Doublons écartés', ex.chevauchants) : ''}
          ${ex.eveilTropLong ? ctxRow('Éveils de plus de 12 h écartés', ex.eveilTropLong) : ''}
        </div>
        <div class="ctx-group">
          <div class="ctx-group-title">Prédicteur 1 — endormissement</div>
          ${ctxRow('Écarts d’éveil mesurés', nVal(p.onset.n))}
          ${ctxRow('Backtests', nVal(p.quality1.n))}
        </div>
        <div class="ctx-group">
          <div class="ctx-group-title">Prédicteur 2 — réveil</div>
          ${ctxRow('Durées de sommeil mesurées', nVal(p.duration.n))}
          ${ctxRow('Backtests', nVal(p.quality2.n))}
        </div>
        <div class="ctx-group">
          <div class="ctx-group-title">Chaînage aller-retour</div>
          ${ctxRow('Réveils prévus dès le réveil précédent', nVal(p.roundtrip.n))}
        </div>
      </div>
    </div>`;

  const estimation = `
    <div class="stat-card stat-card-wide">
      <div class="sc-head"><div class="sc-title">Estimation actuelle — plage de sommeil</div></div>
      <div class="est-rel" id="predRel">${predRelHTML(p)}</div>
      <div class="est-split">
        <div class="est-block">
          <div class="est-block-title">🌙 Endormissement estimé</div>
          ${predOnsetBlock(p)}
        </div>
        <div class="est-block">
          <div class="est-block-title">🌅 Réveil estimé</div>
          ${predWakeBlock(p)}
        </div>
      </div>
    </div>`;

  const note = p.duration.n
    ? `Rappel : la durée de sommeil est plus dispersée que l'écart d'éveil à cet âge (siestes et nuits mélangées) — un écart plus grand ici est attendu, pas forcément un bug.`
    : '';
  const cards = [
    contexte,
    estimation,
    predQualityCard('Qualité du backtest — endormissement', p.quality1,
      { why: `Il en faut ${Stats.BACKTEST_MIN_TRAIN_SAMPLES} écarts d'éveil avant le premier.` }),
    predQualityCard('Qualité du backtest — réveil', p.quality2,
      { note, why: `Il en faut ${Stats.SD_BACKTEST_MIN_TRAIN_SAMPLES} durées de sommeil avant le premier.` }),
    predQualityCard('Qualité du backtest — aller-retour (réveil prévu dès le réveil précédent)', p.roundtrip,
      { wide: true, why: 'C\'est lui qui calibrera la plage du réveil estimé.' }),
    predTableCard('Prédiction vs réalité — endormissement', 'Endormissement', p.quality1),
    predTableCard('Prédiction vs réalité — réveil', 'Réveil', p.quality2),
  ].join('');

  host.innerHTML = `
    <header class="view-header">
      <h1>🔮 Prédiction</h1>
      <p class="view-sub">Backtesting en direct — mode laboratoire</p>
    </header>
    <div class="pred-banner">
      <span class="pb-ic">⚠️</span>
      <span class="pb-txt"><b>Onglet expérimental.</b> Ces chiffres sont recalculés en direct à partir de ce qui est déjà mesuré pour ce bébé. Avec peu de données, ils sont volontairement affichés quand même — regarde le badge et le <i>n</i> de chaque carte pour juger toi-même à quel point t'y fier.</span>
    </div>
    <div id="labSuggest"></div>
    <div class="stat-grid">${cards}</div>
    <div class="lab-sep">
      <h2 class="section-label">🧪 Laboratoire Champion / Challengers</h2>
      <p class="view-sub">Tout est calculé tôt, comparé en walk-forward et montré. Rien n'est promu automatiquement : <b>M0 reste le modèle affiché plus haut</b> tant qu'aucune décision humaine n'a été prise.</p>
    </div>
    <div class="stat-grid" id="labHost"></div>`;

  // Le laboratoire est le seul calcul VRAIMENT lourd : une seule passe ici,
  // les sélecteurs ne re-rendent ensuite que le HTML depuis `labLast`.
  labLast = Stats.sleepLab(Store.all(), { domainStart: DATA_START, birth: BIRTH });
  renderLab();
}

/* ============================================================
   Laboratoire Champion / Challengers — §3.8, §3.10, §3.12, §3.13, §3.14
   ------------------------------------------------------------
   Philosophie tenue à la lettre : tout calculer tôt, tout comparer en
   walk-forward, tout montrer, ne rien promouvoir automatiquement.
   · Un écart entre deux modèles dit seulement qu'ils PENSENT différemment,
     jamais lequel a raison : la table « Maintenant » est donc toujours
     rattachée aux métriques de backtest juste en dessous.
   · Gain apparié = |erreur M0| − |erreur Mx| sur EXACTEMENT les mêmes cas
     (> 0 = le challenger est meilleur). Le taux de victoire est descriptif.
   · Les checkpoints rejouent ce qu'on savait ce jour-là (filtre de préfixe
     sur les cas, aucune ré-estimation avec des données postérieures).
   · Aucun bouton n'active un modèle : `active`/`rejected` restent humains.
   Rien n'est persisté (§3.11) — même les suggestions écartées ne survivent
   pas au rechargement.
   ============================================================ */
const LAB_STATUS = {
  collecting: { emoji: '🌱', label: 'collecte' },
  shadow: { emoji: '👁️', label: 'shadow' },
  exploration: { emoji: '🧪', label: 'exploration' },
  confirming: { emoji: '🧊', label: 'confirmation' },
  active: { emoji: '✅', label: 'actif' },
  rejected: { emoji: '🚫', label: 'rejeté' },
};
const LAB_METRICS = [
  { key: 'gain', label: 'gain vs M0' },
  { key: 'med', label: 'erreur médiane' },
  { key: 'p80', label: 'P80' },
  { key: 'bias', label: 'biais signé' },
];
const LAB_CASES_PAGE = 20;                  // cas affichés par palier (le reste est explicitement annoncé)
let labLast = null;                         // dernier laboratoire calculé (source de tous les re-rendus)
const labDismissed = new Set();             // suggestions écartées — en mémoire seulement
const labUI = { perfT: null, evoT: null, evoMetric: 'gain', cp: 'now', caseT: null, caseM: null, caseN: LAB_CASES_PAGE };

const labMin = v => (v == null || !isFinite(v)) ? '—' : `${Math.round(v)} min`;
const labModel = (lab, id) => lab.models.find(m => m.id === id) || { id, label: id, targets: [] };
const labTargetLabel = k => (Stats.LAB_TARGETS.find(t => t.key === k) || { label: k }).label;
function labStatusChip(st, queued) {
  const m = LAB_STATUS[st] || { emoji: '•', label: st };
  return `<span class="lab-chip lab-${st}">${m.emoji} ${m.label}${queued ? ' · en file' : ''}</span>`;
}
// Gain apparié : + = le challenger fait mieux que M0 (vert), − = pire.
function labGainCell(v, extra) {
  if (v == null || !isFinite(v)) return `<td>—</td>`;
  const r = Math.round(v), cls = r > 0 ? 'err-ok' : (r < 0 ? 'err-mid' : '');
  return `<td class="${cls}">${predSigned(v)}${extra || ''}</td>`;
}
/* Cibles réellement backtestées : pas de sélecteur qui ne mène à rien. */
function labAvailTargets(lab) {
  const seen = new Set(lab.cases.map(c => c.target));
  return Stats.LAB_TARGETS.filter(t => seen.has(t.key));
}
function labSlotTarget(lab, slot) {
  const av = labAvailTargets(lab);
  if (labUI[slot] && av.some(t => t.key === labUI[slot])) return labUI[slot];
  return av.length ? av[0].key : null;
}
function labSeg(slot, options, current) {
  if (options.length < 2) return '';
  return `<div class="seg lab-seg" data-slot="${slot}">${options.map(o =>
    `<button type="button" data-val="${o.key}"${o.key === current ? ' class="active"' : ''}>${o.label}</button>`).join('')}</div>`;
}
function labCard(title, body, o = {}) {
  return `
    <div class="stat-card stat-card-wide"${o.id ? ` id="${o.id}"` : ''}>
      <div class="sc-head"><div class="sc-title">${title}</div>${o.head || ''}</div>
      ${body}
    </div>`;
}
const labEmpty = txt => `<div class="pred-table-empty">${txt}</div>`;
// Features connues AU MOMENT de la prédiction (jamais rien d'ultérieur).
function labFeatText(c) {
  const bits = [];
  if (c.ageDays != null) bits.push(`âge ${c.ageDays} j`);
  bits.push(`${hhmm(c.anchorMs)} locale`);
  bits.push(`dodo préc. ${c.features.prevSleepMin == null ? '—' : fmtDuration(Math.round(c.features.prevSleepMin))}`);
  bits.push(`éveil préc. ${c.features.prevWakeMin == null ? '—' : fmtDuration(Math.round(c.features.prevWakeMin))}`);
  if (c.target === 'remaining' && c.features.elapsedSleepMin != null) {
    bits.push(`déjà endormi ${fmtDuration(Math.round(c.features.elapsedSleepMin))}`);
  }
  // Repas : mesurés à la même ancre que le cas. Absents sur la sonde
  // `remaining` (§3.8.6) — donc rien à afficher, plutôt qu'un « — » trompeur.
  if (c.features.sinceFeedMin != null) {
    const kind = c.features.feedKind === 'bottle' ? 'biberon' : 'tétée';
    const ml = c.features.lastBottleMl != null ? ` ${c.features.lastBottleMl} ml` : '';
    bits.push(`dernier repas ${fmtDuration(Math.round(c.features.sinceFeedMin))} avant (${kind}${ml})`);
    if (c.features.feeds3h != null) bits.push(`${c.features.feeds3h} repas sur 3 h`);
  }
  return bits.join(' · ');
}

/* ---------- ② Champion / Challengers — Maintenant (§3.8.1) ---------- */
function labNowCard(lab) {
  if (!lab.nowRows.length) {
    return labCard('Champion / Challengers — maintenant',
      labEmpty('Aucun dodo enregistré : aucun modèle n’a de quoi se prononcer.'));
  }
  const byT = new Map();
  lab.nowRows.forEach(r => { if (!byT.has(r.target)) byT.set(r.target, []); byT.get(r.target).push(r); });
  const blocks = Stats.LAB_TARGETS.filter(t => byT.has(t.key)).map(t => {
    const rows = byT.get(t.key).map(r => {
      const isCh = r.modelId === lab.championId;
      const perf = (lab.view.perf[r.modelId] || {})[t.key];
      const n = perf ? perf.n : 0;
      const name = `${r.modelId} — ${labModel(lab, r.modelId).label}`;
      if (!r.applicable) {
        return `<tr class="lab-na"><td>${name}</td><td colspan="4">— non applicable <small>(${r.reason})</small></td></tr>`;
      }
      const pred = r.predMs != null ? predClock(r.predMs, lab.nowMs) : `—`;
      const bd = tierBadge(n);
      // La raison va sur une ligne à part, qui s'enroule : dans la cellule
      // « Prédiction » elle élargissait la colonne de 200 px et poussait
      // « Écart vs M0 » et « Statut » hors de l'écran.
      const why = r.predMs == null
        ? `<tr class="lab-feat"><td colspan="5">${r.reason}</td></tr>` : '';
      return `<tr${isCh ? ' class="lab-champ"' : ''}>
        <td>${isCh ? `<b>${name}</b>` : name}</td>
        <td>${pred}</td>
        ${isCh ? '<td>—</td>' : labGainCell(r.deltaVsChampionMin == null ? null : r.deltaVsChampionMin)}
        <td>${bd.emoji} n=${n}</td>
        <td>${labStatusChip(lab.view.byTarget[r.modelId][t.key].status, lab.view.byTarget[r.modelId][t.key].queued)}</td>
      </tr>${why}`;
    }).join('');
    return `
      <div class="lab-block">
        <div class="lab-block-title">${labTargetLabel(t.key)} <small>${t.hint}</small></div>
        <div class="lab-scroll"><table class="pred-table lab-table">
          <thead><tr><th>Modèle</th><th>Prédiction</th><th>Écart vs M0</th><th>Recul</th><th>Statut</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
  }).join('');
  return labCard('Champion / Challengers — maintenant', `
    ${blocks}
    <div class="est-n">Un écart indique seulement que les modèles <b>pensent différemment</b> : il ne dit pas lequel a raison — c'est la carte « Performance comparée » qui le dit. L'écart vs M0 est un écart de <i>prédiction</i> (+ = plus tard que M0), pas une erreur.<br>État : <b>${lab.state === 'ASLEEP' ? 'endormi' : (lab.state === 'AWAKE' ? 'éveillé' : 'inconnu')}</b> · calculé à ${hhmm(lab.nowMs)} <button type="button" class="lab-link" id="labRefresh">↻ recalculer</button></div>`,
    { id: 'lab-now' });
}

/* ---------- ③ Performance comparée (§3.8.2) ---------- */
function labPerfCard(lab) {
  const av = labAvailTargets(lab), t = labSlotTarget(lab, 'perfT');
  const head = labSeg('perfT', av.map(x => ({ key: x.key, label: x.label })), t);
  if (!t) return labCard('Performance comparée', labEmpty('Aucun cas backtesté encore (n=0).'), { id: 'lab-perf' });

  const models = lab.models.filter(m => m.predict && m.targets.includes(t));
  const rows = models.map(m => {
    const p = (lab.view.perf[m.id] || {})[t], pr = (lab.view.paired[m.id] || {})[t];
    const isCh = m.id === lab.championId;
    const name = `${m.id} — ${m.label}`;
    if (!p || !p.n) {
      return `<tr class="lab-na"><td>${name}</td><td colspan="5">aucun backtest encore (n=0)</td></tr>`;
    }
    const bd = tierBadge(p.n);
    return `<tr${isCh ? ' class="lab-champ"' : ''}>
      <td>${isCh ? `<b>${name}</b>` : name}</td>
      <td>${labMin(p.medAbsMin)}</td>
      <td>${labMin(p.p80AbsMin)}</td>
      <td>${predSigned(p.medSignedMin)}</td>
      <td>${bd.emoji} n=${p.n}</td>
      ${isCh ? '<td>—</td>' : labGainCell(pr && pr.pairedN ? pr.medianGainMin : null, pr && pr.pairedN ? ` <small>n=${pr.pairedN}</small>` : '')}
    </tr>`;
  }).join('');

  // Résumé par challenger (§3.8.2) — la comparaison appariée est centrale.
  const summaries = models.filter(m => m.id !== lab.championId).map(m => {
    const p = (lab.view.paired[m.id] || {})[t];
    const bt = lab.view.byTarget[m.id][t];
    if (!p || !p.pairedN) {
      return `<details class="stat-details lab-sum"><summary>${m.id} — ${m.label}</summary>
        <div class="est-empty">${bt.why || 'Aucun cas comparable à M0 pour l’instant.'}</div></details>`;
    }
    const row = (l, v) => `<div class="dt-row"><span class="dt-l">${l}</span><span class="dt-v">${v}</span></div>`;
    const iqr = p.p25GainMin == null ? '' : row('P25 / P75 du gain', `${predSigned(p.p25GainMin)} / ${predSigned(p.p75GainMin)}`);
    return `<details class="stat-details lab-sum"><summary>${m.id} — ${m.label} ${labStatusChip(bt.status, bt.queued)}</summary>
      ${row('n comparable', p.pairedN)}
      ${row(`erreur médiane ${lab.championId}`, labMin(p.championMedAbsMin))}
      ${row(`erreur médiane ${m.id}`, labMin(p.challengerMedAbsMin))}
      ${row(`P80 ${m.id}`, labMin(p.challengerP80AbsMin))}
      ${row(`gain médian vs ${lab.championId}`, predSigned(p.medianGainMin))}
      ${iqr}
      ${row(`${m.id} meilleur`, `${p.wins} / ${p.pairedN} cas${p.ties ? ` (${p.ties} égalité${plural(p.ties)})` : ''}`)}
      ${row(`biais médian ${m.id}`, predSigned(p.challengerMedSignedMin))}
      ${row(`${p.recentShortN} derniers cas`, `gain médian ${predSigned(p.recentShortMedianGainMin)}`)}
      ${row('1er cas comparable', p.firstComparableAgeDays == null ? '—' : `à ${p.firstComparableAgeDays} j`)}
      <div class="sd-note">${bt.why}</div>
      <div class="est-n">Paramètres : ${Object.entries(m.parameters).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' · ') || '—'}<br>${m.note || ''}</div>
    </details>`;
  }).join('');

  return labCard('Performance comparée', `
    <div class="lab-scroll"><table class="pred-table lab-table">
      <thead><tr><th>Modèle</th><th>Err. méd.</th><th>P80</th><th>Biais</th><th>Recul</th><th>Gain vs ${lab.championId}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="est-n">Erreur médiane et P80 = erreur <b>absolue</b> des backtests walk-forward. Biais signé = <b>réel − prévu</b> (+ = le réel arrive plus tard). Gain apparié = |erreur ${lab.championId}| − |erreur Mx| sur exactement les mêmes cas (+ = le challenger est meilleur). Le badge de recul dépend du seul <i>n</i> : ce n'est pas une mesure de précision.</div>
    ${summaries}`, { id: 'lab-perf', head });
}

/* ---------- ④ Évolution dans le temps (§3.8.3) ---------- */
function labEvoCard(lab) {
  const av = labAvailTargets(lab), t = labSlotTarget(lab, 'evoT');
  const head = labSeg('evoT', av.map(x => ({ key: x.key, label: x.label })), t)
    + labSeg('evoMetric', LAB_METRICS, labUI.evoMetric);
  const rows = lab.weekly.filter(w => w.target === t);
  if (!rows.length) {
    return labCard('Évolution dans le temps', labEmpty('Aucun cas comparé à M0 encore — la série se remplira semaine après semaine.'), { id: 'lab-evo', head });
  }
  const ids = [...new Set(rows.map(w => w.challengerId))].sort();
  const weeks = [...new Set(rows.map(w => w.ageWeek))].sort((a, b) => a - b);
  const at = (wk, id) => rows.find(w => w.ageWeek === wk && w.challengerId === id) || null;
  const metric = labUI.evoMetric;
  const showChamp = metric === 'med' || metric === 'p80' || metric === 'bias';
  const cell = r => {
    if (!r) return '<td>—</td>';
    const n = ` <small>n=${r.pairedN}</small>`;
    if (metric === 'gain') return labGainCell(r.medianGainMin, n);
    if (metric === 'med') return `<td>${labMin(r.challengerMedAbsMin)}${n}</td>`;
    if (metric === 'p80') return `<td>${labMin(r.challengerP80AbsMin)}${n}</td>`;
    return `<td>${predSigned(r.challengerMedSignedMin)}${n}</td>`;
  };
  const champCell = wk => {
    const r = rows.find(w => w.ageWeek === wk);
    if (!r) return '<td>—</td>';
    if (metric === 'med') return `<td>${labMin(r.championMedAbsMin)}</td>`;
    return '<td>—</td>';
  };
  const body = weeks.map(wk => `<tr>
      <td>S${wk}</td>
      ${showChamp && metric === 'med' ? champCell(wk) : ''}
      ${ids.map(id => cell(at(wk, id))).join('')}
    </tr>`).join('');
  const note = metric === 'gain'
    ? `Lecture attendue : « cette variable ne servait à rien à S${weeks[0]}, puis son gain devient positif vers S${weeks[weeks.length - 1]} ». Un gain positif isolé sur une semaine à petit <i>n</i> ne veut rien dire.`
    : `Chaque ligne ne contient que les cas de SA semaine, tous prédits en walk-forward : une valeur affichée à S${weeks[0]} n'utilise aucune observation postérieure.`;
  return labCard('Évolution dans le temps', `
    <div class="lab-scroll"><table class="pred-table lab-table">
      <thead><tr><th>Âge</th>${showChamp && metric === 'med' ? `<th>${lab.championId}</th>` : ''}${ids.map(id => `<th>${id}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="est-n">${note}<br>Métrique : <b>${(LAB_METRICS.find(m => m.key === metric) || {}).label}</b> · cible : ${labTargetLabel(t)}.</div>`,
    { id: 'lab-evo', head });
}

/* ---------- ⑤ Checkpoints (§3.8.4 + §3.13) ----------
   Vue reconstruite : les cas sont filtrés sur `realMs <= date`, jamais
   recalculés avec ce qu'on a appris depuis. */
function labCheckpointCard(lab) {
  if (!lab.checkpoints.length) {
    return labCard('Checkpoints', labEmpty('Date de naissance inconnue : impossible de situer les rendez-vous de lecture.'), { id: 'lab-cp' });
  }
  const opts = lab.checkpoints.map(cp =>
    `<option value="${cp.key}"${cp.key === labUI.cp ? ' selected' : ''}>${cp.label}${cp.week != null ? ` · ${new Date(cp.dateMs).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : ''}${cp.future ? ' (à venir)' : ''}</option>`).join('');
  const head = `<select class="lab-select" data-slot="cp">${opts}</select>`;
  const cp = lab.checkpoints.find(c => c.key === labUI.cp) || lab.checkpoints[0];

  if (cp.future || !cp.view) {
    const jours = Math.max(1, Math.round((cp.dateMs - lab.nowMs) / 86400000));
    return labCard('Checkpoints', `
      <div class="lab-block-title">${cp.label} — ${cp.focus}</div>
      <div class="est-empty">Rendez-vous à venir dans ${jours} j (le ${new Date(cp.dateMs).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}). Les modèles concernés (${cp.focusModels.join(', ')}) collectent et backtestent <b>déjà</b> : la semaine ne démarre rien, elle dit seulement « regarde maintenant ».<br><i>${cp.watch}</i></div>`,
      { id: 'lab-cp', head });
  }

  const known = lab.cases.filter(c => c.realMs <= cp.dateMs);
  const focus = cp.focusModels;
  const rows = lab.models.filter(m => m.predict && m.id !== lab.championId).map(m => {
    return m.targets.map(t => {
      const p = (cp.view.paired[m.id] || {})[t], q = (cp.view.perf[m.id] || {})[t];
      const bt = cp.view.byTarget[m.id][t];
      const isFocus = focus.includes(m.id);
      if (!p || !p.pairedN) {
        return `<tr class="lab-na${isFocus ? ' lab-focus' : ''}"><td>${m.id} · ${labTargetLabel(t)}</td><td colspan="6">en attente de données (n=${q ? q.n : 0})</td></tr>`;
      }
      const conf = p.confirmation
        ? `${p.confirmation.currentN}/${p.confirmation.targetN}${p.confirmation.complete ? ' ✓' : ''}`
        : '—';
      return `<tr${isFocus ? ' class="lab-focus"' : ''}>
        <td>${m.id} · ${labTargetLabel(t)}</td>
        <td>${p.pairedN}</td>
        <td>${labMin(p.challengerMedAbsMin)}</td>
        <td>${labMin(p.challengerP80AbsMin)}</td>
        <td>${predSigned(p.challengerMedSignedMin)}</td>
        ${labGainCell(p.medianGainMin)}
        <td>${labStatusChip(bt.status, bt.queued)}<br><small>10 derniers : ${p.recentShortN ? predSigned(p.recentShortMedianGainMin) : '—'} · confirmation ${conf}</small></td>
      </tr>`;
    }).join('');
  }).join('');

  // Évolution hebdomadaire depuis le checkpoint précédent (item 6 du §3.13).
  const prev = lab.checkpoints.filter(c => c.week != null && c.dateMs < cp.dateMs).pop();
  const fromWeek = prev && prev.week != null ? prev.week : 0;
  const toWeek = cp.week != null ? cp.week : Math.floor((lab.ageDays || 0) / 7);
  const evo = lab.weekly.filter(w => w.ageWeek >= fromWeek && w.ageWeek <= toWeek
    && focus.includes(w.challengerId) && known.some(c => c.target === w.target));
  const evoRows = evo.length
    ? `<div class="lab-scroll"><table class="pred-table lab-table">
        <thead><tr><th>Âge</th><th>Modèle</th><th>Cible</th><th>n</th><th>Gain</th></tr></thead>
        <tbody>${evo.map(w => `<tr><td>S${w.ageWeek}</td><td>${w.challengerId}</td><td>${labTargetLabel(w.target)}</td><td>${w.pairedN}</td>${labGainCell(w.medianGainMin)}</tr>`).join('')}</tbody>
      </table></div>`
    : `<div class="est-empty">Pas encore de semaine complète à comparer depuis ${prev ? prev.label : 'le début'}.</div>`;

  // Meilleur / pire cas du modèle mis en avant (item 7) — avec ses features.
  const fm = focus.find(id => {
    const m = labModel(lab, id);
    return m.targets && m.targets.some(t => ((cp.view.paired[id] || {})[t] || {}).pairedN);
  });
  let extremes = `<div class="est-empty">Aucun cas apparié pour ${focus.join(', ')} à cette date : rien à disséquer encore.</div>`;
  if (fm) {
    const cs = known.filter(c => c.preds[fm] && c.preds[lab.championId]);
    const gains = cs.map(c => ({ c, g: c.preds[lab.championId].absErrMin - c.preds[fm].absErrMin }));
    gains.sort((a, b) => b.g - a.g);
    const best = gains[0], worst = gains[gains.length - 1];
    const line = (x, lbl) => `<div class="lab-case">
      <div class="lab-case-h">${lbl} — ${predSigned(x.g)} <small>${labTargetLabel(x.c.target)} · réel ${hhmm(x.c.realMs)} · ${lab.championId} ${hhmm(x.c.preds[lab.championId].predMs)} · ${fm} ${hhmm(x.c.preds[fm].predMs)}</small></div>
      <div class="lab-case-f">${labFeatText(x.c)}</div></div>`;
    extremes = best === worst ? line(best, `Cas unique ${fm}`)
      : `${line(best, `Meilleur cas ${fm}`)}${line(worst, `Pire cas ${fm}`)}`;
  }

  return labCard('Checkpoints', `
    <div class="lab-block-title">${cp.label} — ${cp.focus} <small>${cp.week != null ? new Date(cp.dateMs).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : hhmm(cp.dateMs)}</small></div>
    <div class="est-rel">Ce qu'on regarde : <i>${cp.watch}</i><br>À cette date : ${cp.view.casesN} cas connus · modèles calculables : ${lab.models.filter(m => m.predict && m.targets.some(t => ((cp.view.perf[m.id] || {})[t] || {}).n)).map(m => m.id).join(', ') || 'aucun'}.</div>
    <div class="lab-scroll"><table class="pred-table lab-table">
      <thead><tr><th>Expérience</th><th>n app.</th><th>Err. méd.</th><th>P80</th><th>Biais</th><th>Gain</th><th>Statut</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">Aucun challenger instancié.</td></tr>'}</tbody>
    </table></div>
    <div class="lab-block"><div class="lab-block-title">Évolution depuis ${prev ? prev.label : 'le début'}</div>${evoRows}</div>
    <div class="lab-block"><div class="lab-block-title">Meilleur / pire cas et features associées</div>${extremes}</div>
    <div class="est-n">Vue <b>reconstruite</b> : seuls les cas déjà survenus à cette date sont pris, et chaque prédiction avait déjà été faite en walk-forward — « S6 » ne peut donc pas emprunter un modèle nourri par les données de S10. Décision attendue, volontairement humaine : continuer à observer · geler pour confirmation · promouvoir · rejeter · ne rien faire.</div>`,
    { id: 'lab-cp', head });
}

/* ---------- ⑥ Cas par cas (§3.8.5) ---------- */
function labCasesCard(lab) {
  const av = labAvailTargets(lab), t = labSlotTarget(lab, 'caseT');
  if (!t) return labCard('Cas par cas', labEmpty('Aucun cas backtesté encore (n=0).'), { id: 'lab-cases' });
  const rowsAll = lab.cases.filter(c => c.target === t && c.preds[lab.championId]);
  const challengers = lab.models.filter(m => m.predict && m.id !== lab.championId && m.targets.includes(t)
    && rowsAll.some(c => c.preds[m.id]));
  let sel = labUI.caseM;
  if (sel !== 'all' && !challengers.some(m => m.id === sel)) sel = challengers.length ? challengers[0].id : 'all';
  const shown = sel === 'all' ? challengers.map(m => m.id) : [sel];
  const cols = [lab.championId, ...shown];
  const head = labSeg('caseT', av.map(x => ({ key: x.key, label: x.label })), t)
    + (challengers.length > 1
      ? `<select class="lab-select" data-slot="caseM">${[...challengers.map(m => ({ key: m.id, label: `${m.id} vs ${lab.championId}` })), { key: 'all', label: 'tous les modèles' }]
        .map(o => `<option value="${o.key}"${o.key === sel ? ' selected' : ''}>${o.label}</option>`).join('')}</select>`
      : '');

  if (!rowsAll.length) return labCard('Cas par cas', labEmpty('Aucun cas backtesté pour cette cible.'), { id: 'lab-cases', head });
  const page = rowsAll.slice(-labUI.caseN).reverse();
  const body = page.map(c => {
    const errs = cols.filter(id => c.preds[id]).map(id => ({ id, e: c.preds[id].absErrMin }));
    errs.sort((a, b) => a.e - b.e);
    const best = errs.length ? errs[0].id : null;
    const cells = cols.map(id => {
      const p = c.preds[id];
      if (!p) return '<td>—</td>';
      return `<td class="${id === best ? 'err-ok' : ''}">${hhmm(p.predMs)}<br><small>${predSigned(p.signedErrMin)}</small></td>`;
    }).join('');
    const last = sel === 'all'
      ? `<td>${best || '—'}</td>`
      : labGainCell(c.preds[sel] ? c.preds[lab.championId].absErrMin - c.preds[sel].absErrMin : null);
    return `<tr>
        <td>${new Date(c.anchorMs).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${hhmm(c.anchorMs)}</td>
        <td>${predClock(c.realMs, c.anchorMs)}</td>${cells}${last}
      </tr>
      <tr class="lab-feat"><td colspan="${3 + cols.length}">${labFeatText(c)}</td></tr>`;
  }).join('');
  const more = rowsAll.length > labUI.caseN
    ? `<button type="button" class="lab-link" id="labMore">Afficher ${Math.min(LAB_CASES_PAGE, rowsAll.length - labUI.caseN)} cas de plus</button>`
    : '';
  return labCard('Cas par cas', `
    <div class="lab-scroll"><table class="pred-table lab-table lab-cases">
      <thead><tr><th>Cas</th><th>Réel</th>${cols.map(id => `<th>${id}</th>`).join('')}<th>${sel === 'all' ? 'Meilleur' : 'Gain'}</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="est-n">${page.length} cas affichés sur ${rowsAll.length} (du plus récent au plus ancien) ${more}<br>Sous chaque heure prévue : l'écart signé <b>réel − prévu</b>. La ligne grise donne les features connues <b>au moment</b> de la prédiction — c'est ce qui permet de voir un effet conditionnel (« M3 aide surtout le soir ») au lieu de tout réduire à une moyenne.</div>`,
    { id: 'lab-cases', head });
}

/* ---------- ⑦ Expériences (§3.10 / §3.12) ---------- */
function labExpCard(lab) {
  const items = lab.models.map(m => {
    const st = lab.view.status[m.id];
    const targets = m.targets.length ? m.targets.map(t => {
      const bt = lab.view.byTarget[m.id][t], p = (lab.view.paired[m.id] || {})[t];
      const conf = p && p.confirmation
        ? `<div class="lab-prog"><div class="lab-prog-bar"><span style="width:${Math.min(100, Math.round(100 * p.confirmation.currentN / p.confirmation.targetN))}%"></span></div>
           <div class="lab-prog-txt">bloc de confirmation : ${p.confirmation.currentN} / ${p.confirmation.targetN} nouveaux cas · gain provisoire ${predSigned(p.confirmation.medianGainMin)}${p.confirmation.complete ? ' · <b>complet</b>' : ''}</div></div>`
        : '';
      return `<div class="lab-exp-t">
          <div class="lab-exp-h">${labTargetLabel(t)} ${labStatusChip(bt.status, bt.queued)} ${p && p.pairedN ? `<small>n apparié ${p.pairedN}</small>` : ''}</div>
          <div class="lab-exp-w">${bt.why}</div>
          ${conf}
        </div>`;
    }).join('') : `<div class="lab-exp-w">${m.blocked || 'Aucune cible déclarée.'}</div>`;
    return `<div class="lab-exp">
        <div class="lab-exp-title">${m.id} — ${m.label} <small>v${m.version}</small> ${labStatusChip(st)}</div>
        <div class="lab-exp-note">${m.note || ''}</div>
        ${targets}
      </div>`;
  }).join('');
  return labCard('Expériences', `
    ${items}
    <div class="est-n">Cycle de vie : <code>collecting → shadow → exploration → confirming → active</code> (ou <code>rejected</code>). Aucun statut n'est déduit de l'âge du bébé. Le <b>gel</b> pour confirmation est mécanique ; <b>active</b> et <b>rejected</b> restent des décisions humaines et ne sont jamais posées par l'app. Au plus ${Stats.FEATURE_MAX_CONCURRENT_TRIALS} confirmations en parallèle : les suivantes attendent leur tour. Seuils produit : exploration dès ${Stats.FEATURE_EXPLORATION_MIN_PAIRED_N} cas appariés, gel envisagé dès ${Stats.FEATURE_CONFIRM_TRIGGER_N} cas si le gain médian ≥ ${Math.round(Stats.FEATURE_MIN_GAIN_MIN_MS / 60000)} min, confirmation sur ${Stats.FEATURE_CONFIRM_N} cas non recouvrants.</div>`,
    { id: 'lab-exp' });
}

/* ---------- ⑧ Export LLM (§3.14) ---------- */
function labExportCard(lab) {
  const c = lab.counts;
  return labCard('Analyse externe', `
    <div class="est-empty">Un seul fichier JSON, auto-descriptif (conventions de signe, définitions et consignes de lecture voyagent dedans), généré <b>localement</b> dans le navigateur : rien n'est envoyé à un serveur. Sommeil et <b>rythme des repas</b> (délai, type, volume des biberons, nombre sur 3 h) — puisque c'est ce que les modèles MF testent ; aucun nom, aucune date de naissance, rien des autres domaines — seulement l'âge en jours.</div>
    <button type="button" class="btn btn-primary lab-btn" id="labExport">Exporter pour analyse LLM (.json)</button>
    <div class="est-n" id="labExportSum">${c.models} modèles (${c.instantiated} instanciés) · ${c.cases} cas · ${c.weekFrom == null ? 'aucune semaine' : `S${c.weekFrom}–S${c.weekTo}`} · schéma ${labSchemaLabel()}</div>`,
    { id: 'lab-export' });
}
const labSchemaLabel = () => 'v' + String(Stats.LAB_SCHEMA_VERSION).split('/').pop();

function exportLabJSON() {
  // §3.14 : on recalcule au clic, on construit le snapshot, on télécharge.
  const lab = Stats.sleepLab(Store.all(), { domainStart: DATA_START, birth: BIRTH });
  labLast = lab;
  const snap = Stats.labExport(lab);
  const now = new Date();
  downloadText(`sleep-prediction-lab_${localYMD(now)}_${localHM(now).replace(':', '')}.json`,
    JSON.stringify(snap, null, 2), 'application/json');
  const c = lab.counts;
  const sum = `${c.models} modèles · ${c.cases} cas · ${c.weekFrom == null ? 'aucune semaine' : `S${c.weekFrom}–S${c.weekTo}`} · schéma ${labSchemaLabel()}`;
  const el = document.getElementById('labExportSum');
  if (el) el.innerHTML = `✅ Export généré : ${sum}`;
  toast(sum);
}

/* ---------- ① bis Suggestions in-app (§3.13) ----------
   Deux types seulement, confinés à cet onglet : rappel de checkpoint et
   signal data-driven. Aucune n'active quoi que ce soit. */
function labSuggestions(lab) {
  const out = [];
  const minGain = Stats.FEATURE_MIN_GAIN_MIN_MS / 60000;

  // A. Checkpoint temporel : la semaine est atteinte ET il y a de quoi regarder.
  const past = lab.checkpoints.filter(c => c.week != null && !c.future);
  const cp = past.length ? past[past.length - 1] : null;
  if (cp) {
    const ready = [];
    for (const id of cp.focusModels) {
      const m = labModel(lab, id);
      for (const t of (m.targets || [])) {
        const p = ((cp.view || lab.view).paired[id] || {})[t];
        if (p && p.pairedN >= Stats.FEATURE_EXPLORATION_MIN_PAIRED_N) ready.push({ id, label: m.label, t, n: p.pairedN });
      }
    }
    if (ready.length) {
      const r = ready[0];
      out.push({
        key: `cp-${cp.key}`, ic: '🔬', title: `Point d'étape ${cp.label} disponible`,
        txt: `${r.id} « ${r.label} » dispose maintenant de ${r.n} cas comparables à ${lab.championId} sur la cible ${labTargetLabel(r.t).toLowerCase()}.`,
        acts: [{ act: 'cp', val: cp.key, label: 'Voir les résultats' }, { act: 'later', label: 'Plus tard' }],
      });
    }
  }

  // B. Signal data-driven, indépendant d'une semaine précise.
  for (const m of lab.models) {
    if (!m.predict || m.id === lab.championId) continue;
    for (const t of m.targets) {
      const p = (lab.view.paired[m.id] || {})[t];
      if (!p || !p.pairedN) continue;
      const st = lab.view.byTarget[m.id][t].status;
      if (p.confirmation && p.confirmation.complete) {
        out.push({
          key: `ok-${m.id}-${t}`, ic: '✅', title: 'Résultat confirmé',
          txt: `Sur ${p.confirmation.currentN} nouveaux cas non utilisés pour sélectionner ${m.id}, le gain médian reste ${predSigned(p.confirmation.medianGainMin)}. Décision à prendre : conserver ${lab.championId} ou promouvoir ${m.id}.`,
          acts: [{ act: 'perf', val: t, label: 'Voir le dossier de comparaison' }],
        });
      } else if (st === 'confirming' && p.confirmation) {
        out.push({
          key: `conf-${m.id}-${t}`, ic: '🧪', title: 'Confirmation en cours',
          txt: `${m.id} est gelé. ${p.confirmation.currentN} / ${p.confirmation.targetN} nouveaux cas de confirmation collectés. Gain provisoire : ${predSigned(p.confirmation.medianGainMin)}.`,
          acts: [{ act: 'perf', val: t, label: `Comparer ${m.id} à ${lab.championId}` }],
        });
      } else if (st === 'exploration' && p.medianGainMin != null && p.medianGainMin >= minGain) {
        out.push({
          key: `sig-${m.id}-${t}`, ic: '🧪', title: 'Un challenger se détache',
          txt: `${m.id} améliore la baseline de ${predSigned(p.medianGainMin)} en médiane sur ${p.pairedN} cas appariés. Ce résultat est exploratoire ; aucune modification n'est appliquée.`,
          acts: [{ act: 'perf', val: t, label: `Comparer ${m.id} à ${lab.championId}` }, { act: 'later', label: 'Plus tard' }],
        });
      }
    }
  }
  return out.filter(s => !labDismissed.has(s.key));
}

function renderLab() {
  const lab = labLast;
  const host = document.getElementById('labHost');
  if (!lab || !host) return;
  host.innerHTML = [
    labNowCard(lab), labPerfCard(lab), labEvoCard(lab),
    labCheckpointCard(lab), labCasesCard(lab), labExpCard(lab), labExportCard(lab),
  ].join('');

  const sug = document.getElementById('labSuggest');
  if (sug) {
    sug.innerHTML = labSuggestions(lab).map(s => `
      <div class="lab-sug" data-key="${s.key}">
        <span class="pb-ic">${s.ic}</span>
        <div class="lab-sug-b">
          <div class="lab-sug-t">${s.title}</div>
          <div class="lab-sug-x">${s.txt}</div>
          <div class="lab-sug-a">${s.acts.map(a =>
      `<button type="button" class="lab-link" data-act="${a.act}"${a.val ? ` data-val="${a.val}"` : ''}>${a.label}</button>`).join('')}</div>
        </div>
      </div>`).join('');
  }
  bindLab();
}

function bindLab() {
  document.querySelectorAll('#labHost .lab-seg button').forEach(b => b.onclick = () => {
    labUI[b.parentElement.dataset.slot] = b.dataset.val;
    if (b.parentElement.dataset.slot === 'caseT') labUI.caseN = LAB_CASES_PAGE;
    renderLab();
  });
  document.querySelectorAll('#labHost .lab-select').forEach(s => s.onchange = () => {
    labUI[s.dataset.slot] = s.value;
    renderLab();
  });
  const more = document.getElementById('labMore');
  if (more) more.onclick = () => { labUI.caseN += LAB_CASES_PAGE; renderLab(); };
  const rf = document.getElementById('labRefresh');
  if (rf) rf.onclick = () => renderPrediction();
  const ex = document.getElementById('labExport');
  if (ex) ex.onclick = exportLabJSON;

  document.querySelectorAll('#labSuggest .lab-link').forEach(b => b.onclick = () => {
    const key = b.closest('.lab-sug').dataset.key, act = b.dataset.act;
    if (act === 'later') { labDismissed.add(key); renderLab(); return; }
    if (act === 'cp') labUI.cp = b.dataset.val;
    if (act === 'perf') labUI.perfT = b.dataset.val;
    renderLab();
    const target = document.getElementById(act === 'cp' ? 'lab-cp' : 'lab-perf');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------- Export (exhaustivité pour analyse / IA) ---------- */
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRows(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
function localYMD(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function localHM(d) { return new Date(d).toTimeString().slice(0, 5); }

function exportJSON() {
  const events = Store.all(); // non supprimés, triés par date
  const payload = {
    meta: {
      exported_at: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tz_offset_min: -new Date().getTimezoneOffset(),
      app_version: APP_VERSION,
      schema_version: 1,
      includes_deleted: false,
      count: events.length,
    },
    events,
  };
  downloadText(`suivi-bebe-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('📄 Export JSON');
}
function exportEventsCSV() {
  const tz = -new Date().getTimezoneOffset();
  const header = ['id', 'action', 'ts_utc', 'date_local', 'time_local', 'tz_offset_min', 'side', 'duration_min',
    'volume_ml', 'couche_type', 'is_pee', 'is_poop', 'temp_c', 'med_name', 'sleep_end_utc', 'sleep_duration_min', 'deleted'];
  const rows = [header];
  Store.all().slice().sort((a, b) => new Date(a.ts) - new Date(b.ts)).forEach(e => {
    const d = e.data || {}, t = e.action;
    const isPee = t === 'couche' ? (d.type === 'pipi' || d.type === 'mixte' ? 1 : 0) : '';
    const isPoop = t === 'couche' ? (d.type === 'caca' || d.type === 'mixte' ? 1 : 0) : '';
    const sleepDur = t === 'sommeil' && d.end ? durMin(e.ts, d.end) : '';
    rows.push([
      e.id, t, new Date(e.ts).toISOString(), localYMD(e.ts), localHM(e.ts), tz,
      t === 'tetee' ? (d.side || '') : '',
      t === 'tetee' && d.duration != null ? d.duration : '',
      t === 'biberon' && d.ml != null ? d.ml : '',
      t === 'couche' ? (d.type || '') : '', isPee, isPoop,
      t === 'temperature' && d.temp != null ? d.temp : '',
      t === 'medicament' ? (d.name || '') : '',
      t === 'sommeil' && d.end ? new Date(d.end).toISOString() : '',
      sleepDur, e.deleted ? 1 : 0,
    ]);
  });
  downloadText(`suivi-bebe-evenements-${stamp()}.csv`, csvRows(rows), 'text/csv');
  toast('📄 CSV événements');
}
function exportDailyCSV() {
  const all = Store.all();
  if (!all.length) { toast('Aucune donnée'); return; }
  const earliest = all.reduce((m, e) => Math.min(m, new Date(e.ts).getTime()), Infinity);
  // Math.round (et non floor) : un passage à l'heure d'été rend l'écart plus
  // court de 1 h et ferait perdre le jour le plus ancien de l'export.
  const n = Math.round((startOfDay(new Date()).getTime() - startOfDay(new Date(earliest)).getTime()) / 86400000) + 1;
  const s = Stats.compute(all, { periodDays: Math.max(1, n), domainStart: DATA_START, firstCompleteDay: FIRST_COMPLETE_DAY });
  const header = ['date', 'partiel', 'repas', 'tetees', 'biberons', 'volume_ml', 'temps_sein_min', 'part_biberon_pct',
    'sommeil_min', 'plus_long_sommeil_min', 'nb_dodos', 'pipis', 'cacas', 'couches', 'temp_max_c'];
  const rows = [header];
  s.days.forEach(d => {
    rows.push([
      localYMD(d.date), d.complete ? 0 : 1,
      d.dataRepas ? d.repas : '', d.dataRepas ? d.tetees : '', d.dataRepas ? d.biberons : '',
      d.dataRepas ? d.volumeMl : '', d.dataRepas ? d.teteeDurMin : '', (d.dataRepas && d.repas > 0) ? Math.round(d.bottleShare * 100) : '',
      d.dataSommeil ? d.sleepMin : '', d.dataSommeil ? d.longestSleepMin : '', d.dataSommeil ? d.naps : '',
      d.dataCouche ? d.pipis : '', d.dataCouche ? d.cacas : '', d.dataCouche ? d.couches : '',
      d.tempMax == null ? '' : d.tempMax,
    ]);
  });
  downloadText(`suivi-bebe-quotidien-${stamp()}.csv`, csvRows(rows), 'text/csv');
  toast('📄 CSV quotidien');
}

/* ============================================================
   INTERACTIONS
   ============================================================ */
function onActionTap(action) {
  if (action.id === 'sommeil') { onSleepTap(); return; }
  openActionSheet(action);
}

/* ---------- Bottom sheet ---------- */
const backdrop = document.getElementById('sheetBackdrop');
const sheetBody = document.getElementById('sheetBody');
function openSheet(html) { sheetBody.innerHTML = html; backdrop.hidden = false; }
function closeSheet() { backdrop.hidden = true; sheetBody.innerHTML = ''; }
backdrop.addEventListener('click', e => { if (e.target === backdrop) closeSheet(); });

/* ---------- Suppression : toujours confirmée ----------
   Un tap malheureux a déjà coûté un souvenir : la suppression est un soft-delete
   qui se propage aux deux téléphones, et rien dans l'app ne réaffiche un
   tombstone — donc côté utilisateur, c'est irréversible.
   POINT DE PASSAGE UNIQUE : c'est le seul endroit d'app.js qui appelle
   Store.remove (une garde de test le vérifie), donc aucun bouton ne peut
   supprimer sans passer par cette question.
   Le texte est injecté en textContent (jamais en HTML) : un souvenir peut
   contenir n'importe quel caractère. */
function askDelete(id, o = {}) {
  const bd = document.getElementById('confirmBackdrop');
  const sub = document.getElementById('confirmSub');
  document.getElementById('confirmIcon').textContent = o.icon || '🗑️';
  document.getElementById('confirmTitle').textContent = o.title || 'Supprimer ?';
  sub.textContent = o.sub || ''; sub.hidden = !o.sub;
  const yes = document.getElementById('confirmYes'), no = document.getElementById('confirmNo');
  yes.textContent = o.ok || 'Supprimer';
  no.textContent = o.no || 'Annuler';
  const onKey = e => { if (e.key === 'Escape') fermer(); };
  const fermer = () => { bd.hidden = true; document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  no.onclick = fermer;
  bd.onclick = e => { if (e.target === bd) fermer(); };   // tap à côté = on ne supprime pas
  yes.onclick = () => {
    fermer();
    Store.remove(id);
    closeSheet(); toast(o.done || 'Supprimé'); vibrate(); renderCurrent();
  };
  bd.hidden = false;
}

function save(action, data, ts) {
  Store.add(action.id, data, ts);
  closeSheet(); toast(`${action.emoji} ${action.name} enregistré`); vibrate(); renderCurrent();
}

/* -- Modules de champs par action --
   Chaque module sait produire son HTML pré-rempli (à partir de `data`) et se
   câbler ; `wire` renvoie une fonction `getData()` qui lit l'état courant.
   Réutilisé À L'IDENTIQUE en création (data vide) ET en édition (data existante). */
const FORMS = {
  tetee: {
    html(d, color) {
      const sel = v => d.side === v ? ' selected' : '';
      const dsel = v => Number(d.duration) === v ? ' selected' : '';
      return `
        <div class="sheet-section-label">Côté</div>
        <div class="chips" id="sides" style="--accent:${color}">
          <button type="button" class="chip${sel('gauche')}" data-v="gauche">Gauche</button>
          <button type="button" class="chip${sel('droite')}" data-v="droite">Droite</button>
          <button type="button" class="chip${sel('les deux')}" data-v="les deux">Les deux</button>
        </div>
        <div class="sheet-section-label">Durée (optionnel)</div>
        <div class="presets" id="durations" style="--accent:${color}">
          ${[5, 10, 15, 20, 30].map(v => `<button type="button" class="preset${dsel(v)}" data-v="${v}">${v} min</button>`).join('')}
        </div>`;
    },
    wire(root, d) {
      const state = { side: d.side || null, duration: d.duration != null ? Number(d.duration) : null };
      const sides = root.querySelector('#sides');
      sides.onclick = e => { const c = e.target.closest('.chip'); if (!c) return;
        sides.querySelectorAll('.chip').forEach(x => x.classList.remove('selected')); c.classList.add('selected'); state.side = c.dataset.v; };
      const durations = root.querySelector('#durations');
      durations.onclick = e => { const c = e.target.closest('.preset'); if (!c) return;
        const on = c.classList.contains('selected');
        durations.querySelectorAll('.preset').forEach(x => x.classList.remove('selected'));
        state.duration = on ? null : Number(c.dataset.v); if (!on) c.classList.add('selected'); };
      return () => { const data = {}; if (state.side) data.side = state.side; if (state.duration) data.duration = state.duration; return data; };
    },
  },

  biberon: {
    html(d) {
      const ml = d.ml != null ? Number(d.ml) : 90;
      return `
        <div class="sheet-section-label">Quantité bue</div>
        <div class="stepper">
          <button type="button" id="minus">−</button>
          <div class="value"><span id="mlval">${ml}</span> <small>ml</small></div>
          <button type="button" id="plus">+</button>
        </div>
        <div class="presets" id="mlpresets">
          ${[30, 60, 90, 120, 150, 180].map(v => `<button type="button" class="preset" data-v="${v}">${v}</button>`).join('')}
        </div>`;
    },
    wire(root, d) {
      let ml = d.ml != null ? Number(d.ml) : 90;
      const valEl = root.querySelector('#mlval');
      const setMl = v => { ml = Math.max(0, v); valEl.textContent = ml; };
      root.querySelector('#minus').onclick = () => setMl(ml - 10);
      root.querySelector('#plus').onclick = () => setMl(ml + 10);
      root.querySelector('#mlpresets').onclick = e => { const c = e.target.closest('.preset'); if (c) setMl(Number(c.dataset.v)); };
      return () => ({ ml });
    },
  },

  couche: {
    html(d, color) {
      const sel = v => d.type === v ? ' selected' : '';
      return `
        <div class="sheet-section-label">Contenu</div>
        <div class="chips" id="types" style="--accent:${color}">
          <button type="button" class="chip${sel('pipi')}" data-v="pipi">💧 Pipi</button>
          <button type="button" class="chip${sel('caca')}" data-v="caca">💩 Caca</button>
          <button type="button" class="chip${sel('mixte')}" data-v="mixte">Les deux</button>
        </div>`;
    },
    wire(root, d) {
      let type = d.type || null;
      const types = root.querySelector('#types');
      types.onclick = e => { const c = e.target.closest('.chip'); if (!c) return;
        types.querySelectorAll('.chip').forEach(x => x.classList.remove('selected')); c.classList.add('selected'); type = c.dataset.v; };
      return () => type ? { type } : {};
    },
  },

  temperature: {
    html(d) {
      const temp = d.temp != null ? Number(d.temp) : 36.5;
      return `
        <div class="stepper">
          <button type="button" id="minus">−</button>
          <div class="value"><span id="tval">${fmtTemp(temp)}</span> <small>°C</small></div>
          <button type="button" id="plus">+</button>
        </div>
        <div class="presets" id="tpresets">
          ${[36.5, 37.0, 37.5, 38.0, 38.5].map(v => `<button type="button" class="preset" data-v="${v}">${fmtTemp(v)}</button>`).join('')}
        </div>`;
    },
    wire(root, d) {
      let temp = d.temp != null ? Number(d.temp) : 36.5;
      const tval = root.querySelector('#tval');
      const setTemp = v => { temp = Math.round(v * 10) / 10; tval.textContent = fmtTemp(temp); };
      root.querySelector('#minus').onclick = () => setTemp(temp - 0.1);
      root.querySelector('#plus').onclick = () => setTemp(temp + 0.1);
      root.querySelector('#tpresets').onclick = e => { const c = e.target.closest('.preset'); if (c) setTemp(Number(c.dataset.v)); };
      return () => ({ temp });
    },
  },

  medicament: {
    html(d) {
      return `
        <div class="sheet-section-label">Nom du/des médicament(s)</div>
        <input type="text" class="text-field" id="medName" autocomplete="off" value="${escapeHtml(d.name || '')}" />`;
    },
    wire(root) {
      const input = root.querySelector('#medName');
      return () => { const name = input.value.trim(); return name ? { name } : {}; };
    },
  },
};

/* Feuille unique création/édition d'une action.
   - `ev` absent  → création (heure = defaultTs, bouton "Annuler", save = Store.add)
   - `ev` présent → édition  (heure + champs pré-remplis, bouton "Supprimer", save = update)
   Les actions sans module (bain, checklist) n'affichent que l'heure. */
function openActionSheet(action, ev) {
  const isEdit = !!ev;
  const d = isEdit ? { ...(ev.data || {}) } : {};
  const ts = isEdit ? new Date(ev.ts) : defaultTs();
  const form = FORMS[action.id];
  openSheet(`
    <div class="sheet-title">${action.emoji} ${action.name}</div>
    ${form ? form.html(d, action.color) : ''}
    ${timeFieldHTML(ts)}
    <div class="sheet-actions">
      <button class="btn ${isEdit ? 'btn-danger' : 'btn-ghost'}" id="${isEdit ? 'del' : 'cancel'}">${isEdit ? 'Supprimer' : 'Annuler'}</button>
      <button class="btn btn-primary" id="save" style="--accent:${action.color}">Enregistrer</button>
    </div>`);
  const getTime = wireTimeField(sheetBody, ts);
  const getData = form ? form.wire(sheetBody, d) : () => ({});
  // Focus auto du nom uniquement en création (l'édition ne doit pas ouvrir le clavier d'emblée)
  if (!isEdit && action.id === 'medicament') { const i = sheetBody.querySelector('#medName'); if (i) setTimeout(() => i.focus(), 50); }
  if (isEdit) {
    // Titre sans genre (« ce/cette ») : le nom de l'action est mis en sous-titre,
    // avec l'heure et le détail — de quoi reconnaître la ligne qu'on efface.
    document.getElementById('del').onclick = () => askDelete(ev.id, { icon: action.emoji, title: 'Supprimer cet événement ?', sub: [action.name, hhmm(ev.ts), describe(ev)].filter(Boolean).join(' · ') });
    document.getElementById('save').onclick = () => {
      Store.update(ev.id, { ts: getTime().toISOString(), data: getData() });
      closeSheet(); toast('Modifié'); vibrate(); renderCurrent();
    };
  } else {
    document.getElementById('cancel').onclick = closeSheet;
    document.getElementById('save').onclick = () => save(action, getData(), getTime());
  }
}

/* ---------- Sommeil : début / fin ---------- */
function onSleepTap() {
  const sleep = activeSleep();
  if (sleep) sheetSleepEnd(sleep);
  else sheetSleepStart();
}

function sheetSleepStart() {
  const action = ACTION_MAP.sommeil;
  openSheet(`
    <div class="sheet-title">${action.emoji} Début du dodo</div>
    <div class="sheet-sub">Bébé s'endort maintenant ?</div>
    ${timeFieldHTML(defaultTs(), "Heure du coucher")}
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="cancel">Annuler</button>
      <button class="btn btn-primary" id="save" style="--accent:${action.color}">Démarrer le dodo</button>
    </div>`);
  const getTime = wireTimeField(sheetBody, defaultTs());
  document.getElementById('cancel').onclick = closeSheet;
  document.getElementById('save').onclick = () => {
    Store.add('sommeil', { end: null }, getTime());
    closeSheet(); toast('😴 Dodo démarré'); vibrate(); renderCurrent();
  };
}

function sheetSleepEnd(sleep) {
  const action = ACTION_MAP.sommeil;
  const now = new Date();
  openSheet(`
    <div class="sheet-title">${action.emoji} Fin du dodo</div>
    <div class="sheet-sub">Début : ${hhmm(sleep.ts)}</div>
    <div class="sleep-duration" id="durPreview">${fmtDuration(durMin(sleep.ts, now))}</div>
    ${timeFieldHTML(now, "Heure du réveil")}
    <div class="sheet-actions">
      <button class="btn btn-danger" id="del">Annuler le dodo</button>
      <button class="btn btn-primary" id="save" style="--accent:${action.color}">Fin du dodo</button>
    </div>`);
  const preview = document.getElementById('durPreview');
  const getTime = wireTimeField(sheetBody, now, (d) => { preview.textContent = fmtDuration(durMin(sleep.ts, d)); });
  // Dodo en cours : « Annuler » aurait deux sens ici (annuler le dodo / annuler la
  // question) → « Effacer » vs « Continuer », aucune ambiguïté sur les deux boutons.
  document.getElementById('del').onclick = () => askDelete(sleep.id, { icon: '😴', title: 'Effacer ce dodo en cours ?', sub: `Commencé à ${hhmm(sleep.ts)}`, ok: 'Effacer', no: 'Continuer', done: 'Dodo annulé' });
  document.getElementById('save').onclick = () => {
    Store.patchData(sleep.id, { end: getTime().toISOString() });
    closeSheet(); toast('😴 Dodo enregistré'); vibrate(); renderCurrent();
  };
}

/* ---------- Édition d'un événement du journal ---------- */
function openEditSheet(ev) {
  if (ev.action === 'sommeil') { ev.data && ev.data.end ? sheetSleepEditDone(ev) : sheetSleepEnd(ev); return; }
  const a = ACTION_MAP[ev.action] || { name: ev.action, emoji: '•', color: 'var(--line)' };
  openActionSheet(a, ev);   // même feuille qu'à la création, champs pré-remplis
}

// Édition d'un dodo terminé : début + fin
function sheetSleepEditDone(ev) {
  const a = ACTION_MAP.sommeil;
  openSheet(`
    <div class="sheet-title">${a.emoji} Sommeil</div>
    <div class="sleep-duration" id="durPreview">${fmtDuration(durMin(ev.ts, ev.data.end))}</div>
    <div id="startField">${timeFieldHTML(ev.ts, "Coucher")}</div>
    <div id="endField">${timeFieldHTML(ev.data.end, "Réveil")}</div>
    <div class="sheet-actions">
      <button class="btn btn-danger" id="del">Supprimer</button>
      <button class="btn btn-primary" id="save" style="--accent:${a.color}">Enregistrer</button>
    </div>`);
  const preview = document.getElementById('durPreview');
  const recompute = () => { preview.textContent = fmtDuration(durMin(getStart(), getEnd())); };
  const getStart = wireTimeField(document.getElementById('startField'), ev.ts, recompute);
  const getEnd = wireTimeField(document.getElementById('endField'), ev.data.end, recompute);
  document.getElementById('del').onclick = () => askDelete(ev.id, { icon: '😴', title: 'Supprimer ce dodo ?', sub: `${hhmm(ev.ts)} → ${hhmm(ev.data.end)} · ${fmtDuration(durMin(ev.ts, ev.data.end))}` });
  document.getElementById('save').onclick = () => {
    Store.update(ev.id, { ts: getStart().toISOString() });
    Store.patchData(ev.id, { end: getEnd().toISOString() });
    closeSheet(); toast('Modifié'); renderCurrent();
  };
}

/* ---------- "Ce que j'ai appris" ---------- */
function addLearned() {
  const input = document.getElementById('learnedText');
  const text = input.value.trim();
  if (!text) return;
  Store.add('appris', { text }, defaultTs());
  input.value = '';
  toast('✨ Nouveauté enregistrée'); vibrate(); renderCurrent();
}
function openLearnedSheet(ev) {
  openSheet(`
    <div class="sheet-title">✨ Nouveauté</div>
    <div class="sheet-sub">${new Date(ev.ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    <textarea class="text-field text-area" id="learnedEdit">${escapeHtml(ev.data.text)}</textarea>
    <div class="sheet-actions">
      <button class="btn btn-danger" id="del">Supprimer</button>
      <button class="btn btn-primary" id="save">Enregistrer</button>
    </div>`);
  // Un souvenir ne se rattrape pas : on cite son texte dans la question.
  const effacer = () => askDelete(ev.id, { icon: '✨', title: 'Supprimer ce souvenir ?', sub: `« ${ev.data.text} »`, done: 'Souvenir supprimé' });
  document.getElementById('del').onclick = effacer;
  document.getElementById('save').onclick = () => {
    const t = document.getElementById('learnedEdit').value.trim();
    if (!t) { effacer(); return; }   // champ vidé = suppression → même confirmation
    Store.patchData(ev.id, { text: t });
    closeSheet(); toast('Modifié'); renderCurrent();
  };
}

/* ---------- Toast, vibration, échappement ---------- */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}
function vibrate() { if (navigator.vibrate) navigator.vibrate(15); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- Écran de déverrouillage + pastille de synchro (Phase 3) ---------- */
function showLockScreen(blocking = true) {
  const el = document.getElementById('lockScreen');
  const later = document.getElementById('pinLater');
  if (!el) return;
  el.hidden = false;
  if (later) later.hidden = !!blocking;   // au vrai 1er lancement (aucune donnée), pas d'échappatoire
  const input = document.getElementById('pinInput');
  if (input) setTimeout(() => input.focus(), 50);
}
function hideLockScreen() {
  const el = document.getElementById('lockScreen');
  if (el) el.hidden = true;
}
function wireLockScreen() {
  const el = document.getElementById('lockScreen');
  if (!el) return;
  const input = document.getElementById('pinInput');
  const btn = document.getElementById('pinSubmit');
  const err = document.getElementById('pinError');
  const later = document.getElementById('pinLater');
  const submit = async () => {
    const val = input.value.trim();
    if (!val) return;
    btn.disabled = true; err.textContent = '';
    try {
      await Store.signIn(val);
      input.value = '';
      hideLockScreen();
      renderCurrent();
    } catch (e) {
      err.textContent = 'Code incorrect ou connexion impossible.';
    } finally { btn.disabled = false; }
  };
  btn.onclick = submit;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  if (later) later.onclick = () => hideLockScreen();
}
function updateSyncPill(state) {
  const pill = document.getElementById('syncPill');
  if (!pill) return;
  const map = {
    ok:      { cls: 'sync-ok',      txt: '●', title: 'Synchronisé' },
    pending: { cls: 'sync-pending', txt: '◍', title: 'Synchro en cours…' },
    offline: { cls: 'sync-offline', txt: '○', title: 'Hors ligne — appuyer pour se connecter' },
    local:   { cls: 'sync-local',   txt: '',  title: 'Mode local' },
  };
  const s = map[state] || map.local;
  pill.className = 'sync-pill ' + s.cls;
  pill.textContent = s.txt;
  pill.title = s.title;
  pill.hidden = (state === 'local');       // pas de pastille si la synchro n'est pas configurée
  pill.onclick = (state === 'offline') ? () => showLockScreen(false) : null;
}

/* ---------- Navigation jour ---------- */
document.getElementById('prevDay').onclick = () => { selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate() - 1); renderSuivi(); };
document.getElementById('nextDay').onclick = () => {
  if (isSameDay(selectedDate, startOfDay(new Date()))) return;
  selectedDate = new Date(selectedDate); selectedDate.setDate(selectedDate.getDate() + 1); renderSuivi();
};
document.getElementById('learnedAdd').onclick = addLearned;
document.getElementById('learnedText').addEventListener('keydown', e => { if (e.key === 'Enter') addLearned(); });

/* ---------- Journal : bascule Liste / Frise ---------- */
document.getElementById('journalSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  journalView = b.dataset.view === 'timeline' ? 'timeline' : 'list';
  localStorage.setItem('suivi-bebe-journal-view', journalView);
  renderTimeline();
});
// Tap sur le popover lui-même → ouvre l'édition de l'événement ancré
document.getElementById('journalPop').addEventListener('click', (e) => {
  e.stopPropagation();
  const ev = journalPopEvent;
  if (ev) { hideJournalPop(); openEditSheet(ev); }
});
// Le popover de la frise se ferme au clic ailleurs et au scroll (position fixe)
document.addEventListener('click', hideJournalPop);
window.addEventListener('scroll', () => { if (journalPopAnchor) hideJournalPop(); }, { passive: true });

/* ---------- Init ---------- */
// Synchro entre onglets du même appareil : un autre onglet a modifié le stockage
window.addEventListener('storage', (e) => {
  if (e.key === Store.KEY) {
    Store._cache = null; Store._byId = null; // invalide le cache mémoire → rechargé depuis localStorage
    renderCurrent();
  } else if (e.key === Store.QKEY) {
    Store._queue = null;                      // file modifiée par un autre onglet
  }
});
// Retour de connexion : on tente de vider la file d'envoi
window.addEventListener('online', () => { if (Store._authed) Store._flush(); });

// Retour au premier plan (rouverture via raccourci, changement d'onglet…) :
// la connexion temps réel a pu se couper en arrière-plan → on re-fusionne.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Store._authed) {
    Store.refresh().then(renderCurrent);
  }
});

/* ---------- Tirer pour rafraîchir (pull-to-refresh) ---------- */
function wirePullToRefresh() {
  const ptr = document.getElementById('ptr');
  if (!ptr) return;
  const THRESHOLD = 70;                          // distance (px) à franchir pour déclencher
  const scroller = document.scrollingElement || document.documentElement;
  let startY = null, pulling = false, dist = 0, busy = false;
  const reset = () => { ptr.style.transform = ''; ptr.classList.remove('visible', 'ready'); dist = 0; };

  window.addEventListener('touchstart', (e) => {
    pulling = false;
    if (busy || e.touches.length !== 1 || (scroller.scrollTop || 0) > 0) return;
    const lock = document.getElementById('lockScreen');
    if (!backdrop.hidden || (lock && !lock.hidden)) return;   // pas de PTR si une feuille/le verrou est ouvert
    startY = e.touches[0].clientY; pulling = true; dist = 0;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && (scroller.scrollTop || 0) <= 0) {
      e.preventDefault();                          // empêche le rebond natif pendant qu'on tire
      dist = Math.min(dy * 0.5, 90);               // résistance : on suit à moitié
      ptr.style.transform = `translateY(${dist}px)`;
      ptr.classList.add('visible');
      ptr.classList.toggle('ready', dist >= THRESHOLD);
    } else {
      pulling = false; reset();                    // l'utilisateur remonte / scrolle : on annule
    }
  }, { passive: false });

  window.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (dist >= THRESHOLD) {
      busy = true;
      ptr.classList.remove('ready'); ptr.classList.add('refreshing');
      ptr.style.transform = `translateY(${THRESHOLD}px)`;
      try { await Store.refresh(); renderCurrent(); } catch { /* hors ligne : rien */ }
      ptr.classList.remove('refreshing');
      busy = false;
    }
    reset();
  });
}

wireLockScreen();
wirePullToRefresh();
renderTabbar();
renderCurrent();                              // rendu immédiat depuis le cache local (offline-first)
// Unique timer de l'app : rafraîchit ce qui est relatif à « maintenant ».
// Sur l'onglet Prédiction, SEULE la ligne d'état est réécrite — les prédictions
// elles-mêmes ne sont recalculées qu'à l'ouverture de l'onglet (§3.7).
setInterval(() => {
  if (currentView === 'suivi') { renderStatusStrip(); renderGrid(); }
  else if (currentView === 'prediction') refreshPredictionRel();
}, 60000);

// Démarrage de la synchro (non bloquant pour l'UI)
(async () => {
  const ok = Store.initSupabase();
  if (!ok) { updateSyncPill('local'); return; }   // synchro non configurée → app 100 % locale
  const restored = await Store.restoreSession();
  if (restored) return;                            // session valide : pull + realtime en cours
  // Pas de session : bloquer UNIQUEMENT s'il n'y a aucune donnée locale (vrai 1er lancement)
  if (Store.hasLocalCache()) { updateSyncPill('offline'); }
  else { showLockScreen(true); }
})();
