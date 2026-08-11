/* =========================================================
   Suivi Bébé — Phase 1 (prototype local)
   Données dans localStorage via la couche `Store` (remplaçable
   par Supabase en Phase 3 sans toucher au reste de l'app).

   Modèle unique = un journal d'événements :
     { id, action, data:{}, ts }
   C'est la brique qui alimentera le journal, la vue "Appris",
   et plus tard le dashboard, la heatmap calendrier et l'export.
   ========================================================= */

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
  { id: 'cordon',      name: 'Cordon',           emoji: '🩹', color: 'var(--c-soins)',       place: 'checklist' },
];
const ACTION_MAP = Object.fromEntries(ACTIONS.map(a => [a.id, a]));
const TILE_ACTIONS = ACTIONS.filter(a => a.place === 'tile');
const CHECKLIST_ACTIONS = ACTIONS.filter(a => a.place === 'checklist');

/* Vues (barre d'onglets) — extensible : ajouter 'calendrier' plus tard */
const VIEWS = [
  { id: 'suivi',  label: 'Suivi',  emoji: '📋' },
  { id: 'appris', label: 'Appris', emoji: '✨' },
  { id: 'stats',  label: 'Stats',  emoji: '📊' },
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

/* ---------- Helpers date/heure ---------- */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function ymd(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function isSameDay(a, b) { return ymd(a) === ymd(b); }
function hhmm(d) { return new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false }); }
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
  VIEWS.forEach(v => {
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
    const isToday = isSameDay(selectedDate, startOfDay(new Date()));
    let total = 0, n = 0;
    evs('sommeil').forEach(e => {
      if (e.data && e.data.end) { total += durMin(e.ts, e.data.end); n++; }
      else if (isToday && (Date.now() - new Date(e.ts).getTime()) < SLEEP_MAX_MS) {
        total += durMin(e.ts, new Date()); n++;         // dodo en cours
      }
    });
    return n ? lines([n, fmtDuration(total)]) : '';
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

function renderTimeline() {
  const list = document.getElementById('timeline');
  const count = document.getElementById('timelineCount');
  // Le journal exclut les "appris" (qui ont leur propre section + onglet)
  const events = Store.byDay(selectedDate).filter(e => e.action !== 'appris');
  list.innerHTML = '';
  count.textContent = events.length ? `· ${events.length}` : '';
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'timeline-empty';
    li.textContent = 'Aucune action enregistrée ce jour.';
    list.appendChild(li);
    return;
  }
  events.forEach(ev => {
    const a = ACTION_MAP[ev.action] || { name: ev.action, emoji: '•', color: 'var(--line)' };
    const detail = describe(ev);
    const li = document.createElement('li');
    li.className = 'event';
    li.innerHTML = `
      <div class="ev-dot" style="background:${a.color}33">${a.emoji}</div>
      <div class="ev-main">
        <div class="ev-name">${a.name}</div>
        ${detail ? `<div class="ev-detail">${escapeHtml(detail)}</div>` : ''}
      </div>
      <div class="ev-time">${hhmm(ev.ts)}</div>`;
    li.addEventListener('click', () => openEditSheet(ev));
    list.appendChild(li);
  });
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

/* Courbe (%) avec axes gradués 0 / 50 / 100 + valeur de fin. */
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
  if (li >= 0) {
    const x = xAt(li), y = yAt(values[li]);
    body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`;
    body += `<text x="${(x - 5).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="end" font-size="10" font-weight="700" fill="${color}">${Math.round(values[li])} %</text>`;
  }
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
      chart: statChartLine(shareA, { color: CHART.biberon, labels, W: 300, H: 80 }),
    }),
    card({ // 3 Volume bu (biberon, bleu)
      title: 'Volume bu', hero: `${f0(av.volumeMl)}`, sub: 'ml / j (biberon)',
      chart: statChartBars(volA, { color: CHART.biberon, atten: attFeeds, labels, W: 150, H: 74, valfmt: v => String(v) }),
    }),
    card({ // 4 Temps au sein (tétées, orange) — en face du volume biberon
      title: 'Temps au sein', hero: dur(av.teteeDurMin), sub: '/ j (tétées)',
      chart: statChartBars(teteeDurA, { color: CHART.sein, atten: attFeeds, labels, W: 150, H: 74, dur: true }),
    }),
    card({ // 5 Sommeil total
      title: 'Sommeil', hero: dur(av.sleepMin), sub: '/ j',
      chart: statChartBars(sleepA, { color: CHART.vert, atten: attSleep, labels, W: 150, H: 74, dur: true }),
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
      app_version: 'v23',
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
  const n = Math.floor((startOfDay(new Date()).getTime() - startOfDay(new Date(earliest)).getTime()) / 86400000) + 1;
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
    document.getElementById('del').onclick = () => { Store.remove(ev.id); closeSheet(); toast('Supprimé'); renderCurrent(); };
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
  document.getElementById('del').onclick = () => { Store.remove(sleep.id); closeSheet(); toast('Dodo annulé'); renderCurrent(); };
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
  document.getElementById('del').onclick = () => { Store.remove(ev.id); closeSheet(); toast('Supprimé'); renderCurrent(); };
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
  document.getElementById('del').onclick = () => { Store.remove(ev.id); closeSheet(); toast('Supprimé'); renderCurrent(); };
  document.getElementById('save').onclick = () => {
    const t = document.getElementById('learnedEdit').value.trim();
    if (!t) { Store.remove(ev.id); } else { Store.patchData(ev.id, { text: t }); }
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
setInterval(() => { if (currentView === 'suivi') { renderStatusStrip(); renderGrid(); } }, 60000);

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
