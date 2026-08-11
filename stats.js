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
     dormies DANS chaque jour).
   - Dodo en cours (end=null) : compté jusqu'à maintenant si démarré il y a
     < 16 h ; sinon exclu et signalé (qualité des données).
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

  // Chevauchement en minutes entre [aS,aE] et [bS,bE] (timestamps ms).
  _overlapMin(aS, aE, bS, bE) {
    const s = Math.max(aS, bS), e = Math.min(aE, bE);
    return e > s ? (e - s) / 60000 : 0;
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
                    dodosNonFermes:[ids], dureesNegatives:[ids], tempHorsPlage:[ids] }
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

    // Qualité des données (sur la fenêtre uniquement)
    const quality = { couchesSansType: [], teteesSansCote: [], dodosNonFermes: [], dureesNegatives: [], tempHorsPlage: [] };

    // Période : accumulateurs
    let pLeft = 0, pRight = 0;            // équilibre côtés (les deux = +0.5/+0.5)
    let pTeteeDurSum = 0, pTeteeDurN = 0; // durée tétée moyenne
    let pBains = 0;
    const pMeds = [];
    let pTempMax = null;
    const feedTimesPeriod = [];           // pour l'intervalle moyen sur la période
    const poopTimesPeriod = [];           // cacas/mixtes de la fenêtre → intervalle moyen entre 2 cacas

    // --- Sommeil : traité à part car il faut la découpe à minuit sur toute la fenêtre ---
    for (const e of events) {
      if (e.action !== 'sommeil') continue;
      const startMs = new Date(e.ts).getTime();
      // anomalie : dodo non fermé et trop vieux
      const hasEnd = e.data && e.data.end;
      if (!hasEnd) {
        if (!(nowMs - startMs < this.SLEEP_MAX_MS && nowMs > startMs)) {
          if (Number.isFinite(startMs)) quality.dodosNonFermes.push(e.id);
        }
      } else {
        const endMs = new Date(e.data.end).getTime();
        if (Number.isFinite(endMs) && Number.isFinite(startMs) && endMs < startMs) quality.dureesNegatives.push(e.id);
      }
      const s = this._resolveSleep(e, nowMs);
      if (!s || !s.valid) continue;
      // Nombre de dodos + plus long épisode : rattachés au jour de DÉBUT
      const startDay = byKey.get(this.dayKey(new Date(s.startMs)));
      const epMin = Math.round((s.endMs - s.startMs) / 60000);
      if (startDay) { startDay.naps += 1; if (epMin > startDay.longestSleepMin) startDay.longestSleepMin = epMin; }
      // Total /jour : découpe à minuit sur chaque jour de la fenêtre chevauché
      if (s.endMs <= firstMs || s.startMs >= lastMs) continue; // hors fenêtre
      for (const d of days) {
        const dS = d.date.getTime();
        const dE = this.addDays(d.date, 1).getTime();
        const ov = this._overlapMin(s.startMs, s.endMs, dS, dE);
        if (ov > 0) d.sleepMin += ov;
      }
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
