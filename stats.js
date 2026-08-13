/* =========================================================
   Suivi Bébé — Couche de calcul des statistiques (PURE)
   -----------------------------------------------------------
   Aucune dépendance à l'UI ni à app.js : uniquement des fonctions
   pures event[] -> KPI. Toute la PRÉCISION se joue ici (règles §0
   des specs). Testable en isolation (on peut injecter `now`).

   Modèle d'événement attendu :
     { id, action, data:{}, ts (ISO), deleted?, created_at? }

   Règles clefs :
   - Jour = jour civil LOCAL (minuit→minuit du téléphone).
   - Sommeil à cheval sur minuit : DÉCOUPÉ à minuit (minutes réellement
     dormies DANS chaque jour) → cf. sleepSegments(). Un 22h30→02h compte
     1h30 le 1er jour et 2h le 2e, et vaut 1 dodo de chaque côté (impossible
     autrement sans fausser les totaux quotidiens).
   - Exception assumée : "plus long sommeil" garde le sens de plus longue
     traite SANS RÉVEIL → durée de l'épisode ENTIER, rattachée au jour qui en
     contient le plus de minutes (à égalité : le jour de début). Sur ce jour,
     longestSleepMin peut donc dépasser sleepMin.
   - Dodo en cours (end=null) : compté jusqu'à maintenant si démarré il y a
     < 16 h ; sinon exclu et signalé (qualité des données).
   - Dodo CLOS de ≥ 16 h (SLEEP_MAX_MS) : physiquement impossible (oubli d'arrêt
     fermé le lendemain) → COMPTÉ quand même (les stats restent le reflet exact
     du journal) mais SIGNALÉ en qualité pour correction.
   - Dodos qui se CHEVAUCHENT (même sieste saisie depuis les 2 téléphones) :
     minutes additionnées (idem, reflet du journal) et le plus tardif est
     SIGNALÉ en qualité. Une journée peut donc dépasser 1440 min tant que le
     doublon n'est pas supprimé.
   - Invariant d'arrondi : la somme des minutes des segments d'un épisode est
     TOUJOURS égale à son totalMin (pas de dérive ±1 min avec des secondes ≠ 0).
   - Qualité des données : anomalies cherchées SUR LA FENÊTRE uniquement (tous
     domaines, sommeil compris) — la boîte affichée suit le sélecteur 7/14/30 j.
     Listes triées du + récent au + ancien (ordre stable, indépendant de l'ordre
     d'arrivée des événements).
   - Aujourd'hui = jour partiel : EXCLU des moyennes.
   - Jour "suivi" = jour avec ≥ 1 événement ; un jour totalement vide est
     considéré "non suivi" et n'entre pas au dénominateur des moyennes
     (évite les faux zéros quand l'app n'a pas été utilisée ce jour-là).
   - Champ manquant : l'événement compte dans son total, mais est exclu de la
     sous-métrique qui a besoin du champ (dénominateur explicite).
   - Durée négative (end < start) : bornée à 0 + signalée.
   - Tombstones (deleted) : toujours exclus.
   ========================================================= */
const Stats = {
  SLEEP_MAX_MS: 16 * 60 * 60 * 1000,
  TEMP_ALERT: 38.0,        // °C : seuil d'alerte
  TEMP_MIN: 34.0,          // plage plausible (hors → anomalie)
  TEMP_MAX: 42.0,

  /* ---------- Helpers date (locaux, auto-suffisants) ---------- */
  startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; },
  addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; },
  isSameDay(a, b) { return this.dayKey(a) === this.dayKey(b); },

  // Fenêtre de N jours civils se terminant à `anchor` (inclus), du + ancien au + récent.
  daysWindow(anchor, n) {
    const end = this.startOfDay(anchor);
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(this.startOfDay(this.addDays(end, -i)));
    return out;
  },

  /* ---------- Aperçu d'un point de sommeil (résolu) ----------
     Renvoie { startMs, endMs, valid, ongoing } ou null si à ignorer.
     - end présent  : épisode terminé (valid si end>start, sinon durée 0).
     - end absent   : en cours → end=now si (now-start)<16h, sinon ignoré. */
  _resolveSleep(ev, nowMs) {
    if (!ev || ev.action !== 'sommeil') return null;
    const startMs = new Date(ev.ts).getTime();
    if (!Number.isFinite(startMs)) return null;
    const end = ev.data && ev.data.end;
    if (end) {
      const endMs = new Date(end).getTime();
      if (!Number.isFinite(endMs)) return null;
      return { startMs, endMs: Math.max(endMs, startMs), valid: endMs > startMs, ongoing: false, rawEndMs: endMs };
    }
    // en cours
    if (nowMs - startMs < this.SLEEP_MAX_MS && nowMs > startMs) {
      return { startMs, endMs: nowMs, valid: true, ongoing: true, rawEndMs: nowMs };
    }
    return null; // dodo oublié (>16h) : ignoré ici, signalé en qualité
  },

  /* ---------- Découpe d'un sommeil en segments de jour civil ----------
     SOURCE UNIQUE de la règle "à cheval sur minuit" : stats ET affichage
     (journal, frise, badges) consomment cette fonction, jamais la durée brute.
     Renvoie, du plus ancien au plus récent :
       [{ dayMs, startMs, endMs, min, contPrev, contNext, ongoing, totalMin }]
     - min      : minutes dormies DANS ce jour (ce que le jour comptabilise) ;
     - totalMin : durée de l'épisode entier (pour "plus long sommeil"), égale par
       construction à la SOMME des `min` (aucune dérive d'arrondi possible) ;
     - contPrev/contNext : le segment est tronqué à minuit avant/après.
     [] si l'épisode est à ignorer (dodo oublié > 16 h, durée nulle/négative). */
  sleepSegments(ev, nowMs) {
    const s = this._resolveSleep(ev, nowMs != null ? nowMs : Date.now());
    if (!s || !s.valid) return [];
    return this._splitAtMidnight(s);
  },

  // Découpe brute d'un épisode déjà résolu ({startMs, endMs, ongoing}).
  // Utilisée par sleepSegments() et par compute() (via sleepEpisodes()).
  _splitAtMidnight(s) {
    const out = [];
    let cur = this.startOfDay(new Date(s.startMs));
    // garde-fou : un épisode aberrant (date corrompue) ne doit pas boucler
    for (let i = 0; i < 32 && cur.getTime() < s.endMs; i++) {
      const dS = cur.getTime(), dE = this.addDays(cur, 1).getTime();
      const a = Math.max(dS, s.startMs), b = Math.min(dE, s.endMs);
      if (b > a) out.push({
        dayMs: dS, startMs: a, endMs: b,
        min: Math.round((b - a) / 60000),
        contPrev: a > s.startMs, contNext: b < s.endMs,
        ongoing: !!s.ongoing && b >= s.endMs,
        totalMin: 0,   // renseigné juste après (= somme des min)
      });
      cur = this.addDays(cur, 1);
    }
    const totalMin = out.reduce((t, g) => t + g.min, 0);
    for (const g of out) g.totalMin = totalMin;
    return out;
  },

  /* ---------- Liste des épisodes de sommeil (résolus, triés) ----------
     SOURCE UNIQUE des épisodes : qualité des données, agrégats et (à venir)
     prédictif partent de là — jamais des événements bruts.
     Renvoie, du plus ancien au plus récent :
       [{ id, startMs, endMs, min, ongoing, aberrant, overlapsPrev }]
     - min          : durée de l'épisode ENTIER (pas de découpe ici) ;
     - aberrant     : épisode clos de ≥ 16 h → saisie invraisemblable (compté
                      mais signalé) ;
     - overlapsPrev : démarre avant la fin de l'épisode précédent (doublon).
     Les épisodes ignorés (durée ≤ 0, dodo oublié > 16 h en cours, dates
     invalides) n'apparaissent pas ; ils sont signalés par compute(). */
  sleepEpisodes(allEvents, opts = {}) {
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const out = [];
    for (const e of (allEvents || [])) {
      if (!e || e.deleted || e.action !== 'sommeil') continue;
      const s = this._resolveSleep(e, nowMs);
      if (!s || !s.valid) continue;
      out.push({
        id: e.id, startMs: s.startMs, endMs: s.endMs,
        min: Math.round((s.endMs - s.startMs) / 60000),
        ongoing: s.ongoing,
        aberrant: !s.ongoing && (s.endMs - s.startMs) >= this.SLEEP_MAX_MS,
        overlapsPrev: false,
      });
    }
    out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    // on compare à la fin la plus tardive vue jusqu'ici (un long épisode peut
    // en englober un court : le suivant chevauche quand même)
    for (let i = 1, maxEnd = out.length ? out[0].endMs : 0; i < out.length; i++) {
      if (out[i].startMs < maxEnd) out[i].overlapsPrev = true;
      if (out[i].endMs > maxEnd) maxEnd = out[i].endMs;
    }
    return out;
  },

  /* ---------- Agrégat par jour + période ----------
     allEvents : tableau brut (Store.all() convient ; on refiltre deleted).
     opts.periodDays : taille de la fenêtre (7/14/30).
     opts.now : instant de référence (défaut new Date()).
     Retour :
       {
         days: [{ date, key, partial, tracked, tetees, biberons, repas,
                  bottleShare, volumeMl, pipis, cacas, couches,
                  sleepMin, longestSleepMin, naps, tempMax }],   // ancien→récent
         today: <agrégat du jour courant, partiel>,
         averages: { …/jour sur les jours SUIVIS complets… },
         period: { bottleShare, sideLeftPct, sideRightPct, avgFeedGapMin,
                   longestFeedGapMin, avgTeteeDurationMin, avgPoopGapMin,
                   tempMax, tempAlert, bains, meds:[{ts,name}], trackedDays },
         quality: { couchesSansType:[ids], teteesSansCote:[ids],
                    dodosNonFermes:[ids], dureesNegatives:[ids],
                    dureesAberrantes:[ids], dodosChevauchants:[ids],
                    tempHorsPlage:[ids] }   // anomalies de la FENÊTRE seulement
       }
  */
  compute(allEvents, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const nowMs = now.getTime();
    const periodDays = opts.periodDays || 7;
    const events = (allEvents || []).filter(e => e && !e.deleted);

    const window = this.daysWindow(now, periodDays);
    const firstMs = window[0].getTime();
    const lastMs = this.addDays(window[window.length - 1], 1).getTime(); // borne haute exclue (minuit suivant)
    const todayKey = this.dayKey(now);

    // Fiabilité des données par domaine (jour à partir duquel la donnée existe) et
    // 1er jour civil COMPLET. Optionnels : sans eux, comportement historique
    // (toutes les données présentes, un jour complet = tout sauf aujourd'hui).
    const ds = opts.domainStart || {};
    const startMsOf = v => (v != null ? this.startOfDay(v).getTime() : -Infinity);
    const dsRepas = startMsOf(ds.repas);
    const dsCouche = startMsOf(ds.couche);
    const dsSommeil = startMsOf(ds.sommeil);
    const firstCompleteMs = opts.firstCompleteDay != null ? this.startOfDay(opts.firstCompleteDay).getTime() : -Infinity;

    // Squelette par jour. Drapeaux de fiabilité :
    //  dataRepas/dataCouche/dataSommeil = ce domaine a-t-il des données ce jour-là
    //    (avant sa date de début → false → "pas de donnée", jamais un zéro) ;
    //  complete = jour civil complet et moyennable (ni aujourd'hui, ni un jour
    //    antérieur au 1er jour complet, ex. le jour de naissance partiel).
    const byKey = new Map();
    const days = window.map(date => {
      const dms = date.getTime();
      const o = {
        date, key: this.dayKey(date), partial: this.dayKey(date) === todayKey,
        complete: this.dayKey(date) !== todayKey && dms >= firstCompleteMs,
        dataRepas: dms >= dsRepas, dataCouche: dms >= dsCouche, dataSommeil: dms >= dsSommeil,
        tracked: false,
        tetees: 0, biberons: 0, repas: 0, bottleShare: null, volumeMl: 0,
        teteeDurMin: 0,
        pipis: 0, cacas: 0, couches: 0,
        sleepMin: 0, longestSleepMin: 0, naps: 0,
        tempMax: null,
        _feedTimes: [],   // interne : heures des repas (pour intervalles)
      };
      byKey.set(o.key, o);
      return o;
    });

    // Qualité des données (anomalies dont l'événement DÉMARRE dans la fenêtre)
    const quality = {
      couchesSansType: [], teteesSansCote: [],
      dodosNonFermes: [], dureesNegatives: [], dureesAberrantes: [], dodosChevauchants: [],
      tempHorsPlage: [],
    };
    const inWindow = ms => Number.isFinite(ms) && ms >= firstMs && ms < lastMs;

    // Période : accumulateurs
    let pLeft = 0, pRight = 0;            // équilibre côtés (les deux = +0.5/+0.5)
    let pTeteeDurSum = 0, pTeteeDurN = 0; // durée tétée moyenne
    let pBains = 0;
    const pMeds = [];
    let pTempMax = null;
    const feedTimesPeriod = [];           // pour l'intervalle moyen sur la période
    const poopTimesPeriod = [];           // cacas/mixtes de la fenêtre → intervalle moyen entre 2 cacas

    // --- Sommeil : traité à part car il faut la découpe à minuit sur toute la
    // fenêtre (une nuit démarrée AVANT la fenêtre y déverse ses minutes) ---

    // 1) Anomalies détectables sur l'événement brut (dodo oublié, durée négative)
    for (const e of events) {
      if (e.action !== 'sommeil') continue;
      const startMs = new Date(e.ts).getTime();
      if (!inWindow(startMs)) continue;
      const hasEnd = e.data && e.data.end;
      if (!hasEnd) {
        if (!(nowMs - startMs < this.SLEEP_MAX_MS && nowMs > startMs)) quality.dodosNonFermes.push(e.id);
      } else {
        const endMs = new Date(e.data.end).getTime();
        if (Number.isFinite(endMs) && endMs < startMs) quality.dureesNegatives.push(e.id);
      }
    }

    // 2) Épisodes résolus (triés, chevauchements marqués) → découpe + agrégats
    for (const ep of this.sleepEpisodes(events, { nowMs })) {
      if (inWindow(ep.startMs)) {
        if (ep.aberrant) quality.dureesAberrantes.push(ep.id);
        if (ep.overlapsPrev) quality.dodosChevauchants.push(ep.id);
      }
      // Découpe à minuit : chaque jour chevauché encaisse SES minutes + 1 dodo.
      const segs = this._splitAtMidnight(ep);
      if (!segs.length) continue;
      let best = segs[0];
      for (const g of segs) {
        const d = byKey.get(this.dayKey(new Date(g.dayMs)));   // undefined = hors fenêtre
        if (d) { d.sleepMin += g.min; d.naps += 1; }
        if (g.min > best.min) best = g;                        // ">" ⇒ à égalité, le jour de début
      }
      // Plus long sommeil = épisode ENTIER (traite sans réveil), sur le jour majoritaire.
      const bestDay = byKey.get(this.dayKey(new Date(best.dayMs)));
      if (bestDay && best.totalMin > bestDay.longestSleepMin) bestDay.longestSleepMin = best.totalMin;
    }

    // --- Autres événements de la fenêtre ---
    for (const e of events) {
      const ms = new Date(e.ts).getTime();
      if (!Number.isFinite(ms) || ms < firstMs || ms >= lastMs) continue;
      const day = byKey.get(this.dayKey(new Date(ms)));
      if (!day) continue;
      // "tracked" = jour où une donnée de routine a été saisie (tétée/biberon/couche/
      // température/bain/médicament, ou sommeil valide traité plus haut). La checklist
      // et les "appris" ne suffisent pas à qualifier un jour de suivi (sinon faux zéros).

      switch (e.action) {
        case 'tetee': {
          day.tracked = true;
          day.tetees++; day.repas++; day._feedTimes.push(ms); feedTimesPeriod.push(ms);
          const side = e.data && e.data.side;
          if (side === 'gauche') pLeft++;
          else if (side === 'droite') pRight++;
          else if (side === 'les deux') { pLeft += 0.5; pRight += 0.5; }
          else quality.teteesSansCote.push(e.id);
          const dur = e.data && e.data.duration;
          if (dur != null && Number.isFinite(Number(dur))) { pTeteeDurSum += Number(dur); pTeteeDurN++; day.teteeDurMin += Number(dur); }
          break;
        }
        case 'biberon': {
          day.tracked = true;
          day.biberons++; day.repas++; day._feedTimes.push(ms); feedTimesPeriod.push(ms);
          const ml = e.data && e.data.ml;
          if (ml != null && Number.isFinite(Number(ml))) day.volumeMl += Number(ml);
          break;
        }
        case 'couche': {
          day.tracked = true;
          day.couches++;
          const t = e.data && e.data.type;
          if (t === 'pipi' || t === 'mixte') day.pipis++;
          if (t === 'caca' || t === 'mixte') { day.cacas++; poopTimesPeriod.push(ms); }
          if (!t) quality.couchesSansType.push(e.id);
          break;
        }
        case 'temperature': {
          day.tracked = true;
          const temp = e.data && e.data.temp;
          if (temp != null && Number.isFinite(Number(temp))) {
            const v = Number(temp);
            if (day.tempMax === null || v > day.tempMax) day.tempMax = v;
            if (pTempMax === null || v > pTempMax) pTempMax = v;
            if (v < this.TEMP_MIN || v > this.TEMP_MAX) quality.tempHorsPlage.push(e.id);
          }
          break;
        }
        case 'bain': day.tracked = true; pBains++; break;
        case 'medicament': day.tracked = true; pMeds.push({ ts: e.ts, name: (e.data && e.data.name) || 'Médicament' }); break;
        default: break; // checklist / appris : ignorés ici
      }
    }

    // Marque "tracked" les jours ayant du sommeil même sans autre événement
    for (const d of days) if (d.sleepMin > 0) d.tracked = true;

    // Finitions par jour : arrondis + part du biberon
    for (const d of days) {
      d.sleepMin = Math.round(d.sleepMin);
      d.volumeMl = Math.round(d.volumeMl);
      d.teteeDurMin = Math.round(d.teteeDurMin);
      d.bottleShare = d.repas > 0 ? d.biberons / d.repas : null;
      // intervalle max de la journée (plus longue pause entre repas)
      d.longestFeedGapMin = this._maxGap(d._feedTimes);
      delete d._feedTimes;
    }

    // Moyennes : sur les jours SUIVIS, COMPLETS *et* où le domaine a des données
    // (aujourd'hui et le jour de naissance partiel exclus ; couches/sommeil exclus
    // avant leur date de fiabilité → pas de faux zéros qui écraseraient la moyenne).
    const completeGlobal = days.filter(d => d.complete && d.tracked);
    const avgOn = (sel, flag) => {
      const el = days.filter(d => d.complete && d.tracked && d[flag]);
      return el.length ? el.reduce((s, d) => s + sel(d), 0) / el.length : null;
    };
    const nDays = flag => days.filter(d => d.complete && d.tracked && d[flag]).length;
    const averages = {
      trackedDays: completeGlobal.length,
      trackedDaysRepas: nDays('dataRepas'),
      trackedDaysCouche: nDays('dataCouche'),
      trackedDaysSommeil: nDays('dataSommeil'),
      repas: avgOn(d => d.repas, 'dataRepas'),
      tetees: avgOn(d => d.tetees, 'dataRepas'),
      biberons: avgOn(d => d.biberons, 'dataRepas'),
      volumeMl: avgOn(d => d.volumeMl, 'dataRepas'),
      teteeDurMin: avgOn(d => d.teteeDurMin, 'dataRepas'),
      pipis: avgOn(d => d.pipis, 'dataCouche'),
      cacas: avgOn(d => d.cacas, 'dataCouche'),
      couches: avgOn(d => d.couches, 'dataCouche'),
      sleepMin: avgOn(d => d.sleepMin, 'dataSommeil'),
      longestSleepMin: avgOn(d => d.longestSleepMin, 'dataSommeil'),
      naps: avgOn(d => d.naps, 'dataSommeil'),
    };

    // Ratios de PÉRIODE (descriptifs) : sur TOUTE la fenêtre, aujourd'hui INCLUS
    // (une fièvre / un médicament / un repas d'aujourd'hui ne doit pas être masqué).
    // À distinguer des moyennes /jour ci-dessus, elles excluent le jour partiel.
    const sumBib = days.reduce((s, d) => s + d.biberons, 0);
    const sumRepas = days.reduce((s, d) => s + d.repas, 0);
    const sideTotal = pLeft + pRight;
    const period = {
      trackedDays: completeGlobal.length,
      bottleShare: sumRepas > 0 ? sumBib / sumRepas : null,
      sideLeftPct: sideTotal > 0 ? Math.round((pLeft / sideTotal) * 100) : null,
      sideRightPct: sideTotal > 0 ? Math.round((pRight / sideTotal) * 100) : null,
      avgFeedGapMin: this._avgGap(feedTimesPeriod),
      longestFeedGapMin: this._maxGap(feedTimesPeriod),
      avgTeteeDurationMin: pTeteeDurN ? Math.round(pTeteeDurSum / pTeteeDurN) : null,
      avgPoopGapMin: this._avgGap(poopTimesPeriod),
      tempMax: pTempMax,
      tempAlert: pTempMax !== null && pTempMax >= this.TEMP_ALERT,
      bains: pBains,
      meds: pMeds.sort((a, b) => new Date(b.ts) - new Date(a.ts)),
    };

    // Anomalies du + récent au + ancien (comme le journal). Sans ce tri, l'ordre
    // des lignes dépendrait de l'ordre d'arrivée des événements — instable, et
    // incohérent entre les types (le sommeil est balayé par épisodes triés).
    const tsById = new Map(events.map(e => [e.id, new Date(e.ts).getTime()]));
    for (const k in quality) quality[k].sort((a, b) => (tsById.get(b) || 0) - (tsById.get(a) || 0));

    const today = days.find(d => d.partial) || null;
    return { days, today, averages, period, quality };
  },

  // Écarts consécutifs (min) entre horodatages triés
  _gaps(times) {
    if (!times || times.length < 2) return [];
    const t = times.slice().sort((a, b) => a - b);
    const g = [];
    for (let i = 1; i < t.length; i++) g.push((t[i] - t[i - 1]) / 60000);
    return g;
  },
  _avgGap(times) { const g = this._gaps(times); return g.length ? Math.round(g.reduce((s, x) => s + x, 0) / g.length) : null; },
  _maxGap(times) { const g = this._gaps(times); return g.length ? Math.round(Math.max(...g)) : null; },
};

if (typeof window !== 'undefined') window.Stats = Stats;
