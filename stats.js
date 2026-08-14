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

  /* =========================================================
     PRÉDICTIF SOMMEIL — socle V1 (RECOS-prediction-sommeil-v5.md §3.2→§3.6)
     -----------------------------------------------------------
     Deux prédicteurs indépendants, même mécanique — fenêtre glissante puis
     médiane + P25/P75 (JAMAIS moyenne + min/max : une seule nuit de 10 h
     ferait exploser une moyenne, et un min/max décrit les extrêmes, pas
     l'habituel) :
       1. écart d'éveil   (fin d'un dodo → début du suivant) → endormissement
       2. durée de sommeil (début → fin d'un dodo)           → réveil
     Chaînés en aller-retour quand bébé est éveillé (réveil = endormissement
     prévu + durée prévue). La PLAGE du réveil est alors calibrée sur les
     résidus SIGNÉS du backtest aller-retour (§3.4), pas sur P25+P25 / P75+P75
     qui empilerait deux incertitudes indépendantes (plage trop large).

     Backtests walk-forward (§3.5) : une prédiction n'est calculée qu'avec les
     échantillons CONNUS à l'instant où elle aurait été faite. Chaque
     échantillon porte donc `atMs` = l'instant où il devient connaissable
     (début du dodo suivant pour un écart d'éveil, fin du dodo pour une durée),
     et _predWindow() coupe à `asOfMs` : aucune fuite du futur possible, ni en
     direct ni en backtest. Rien n'est persisté — tout est rejoué au calcul.

     Épisodes ÉCARTÉS des échantillons (décision d'audit du 13 août 2026) :
     `aberrant` (fin oubliée, ≥ 16 h) et `overlapsPrev` (même sieste saisie
     depuis les 2 téléphones). Ils restent comptés dans les stats et signalés
     dans « Qualité des données », mais fausseraient médiane ET backtest.
     ========================================================= */

  // Seuils du prédictif : CHOIX PRODUIT documentés (§3.2/§3.3/§3.5), pas des
  // frontières mathématiques. La seule impossibilité d'affichage est n = 0.
  WAKE_GAP_MAX_MS: 12 * 60 * 60 * 1000,   // au-delà, ce n'est plus un éveil (fin de dodo oubliée)
  WW_WINDOW_DAYS: 14,                     // écart d'éveil : profondeur de la fenêtre
  WW_WINDOW_MAX_SAMPLES: 40,
  WW_MIN_SAMPLES_FOR_RANGE: 3,            // médiane dès n=1, plage seulement à partir de n=3
  SD_WINDOW_DAYS: 14,                     // durée de sommeil : idem
  SD_WINDOW_MAX_SAMPLES: 40,
  SD_MIN_SAMPLES_FOR_RANGE: 3,
  SD_MAX_IQR_MEDIAN_RATIO: 2.5,           // au-delà : plage large (siestes + nuits mélangées)
  BACKTEST_MIN_TRAIN_SAMPLES: 3,          // backtest écart d'éveil
  BACKTEST_TIER_EMERGING_N: 20,
  BACKTEST_TIER_SOLID_N: 40,
  SD_BACKTEST_MIN_TRAIN_SAMPLES: 3,       // backtest durée de sommeil
  SD_BACKTEST_TIER_EMERGING_N: 20,
  SD_BACKTEST_TIER_SOLID_N: 40,
  RT_TIER_EMERGING_N: 20,                 // backtest aller-retour (réveil)
  RT_TIER_SOLID_N: 40,

  /* Quantile par interpolation linéaire (méthode 7, celle de numpy/Excel).
     p ∈ [0,1]. null si aucun échantillon. Minutes gardées en flottant :
     l'arrondi n'a lieu qu'à l'affichage. */
  _quantile(values, p) {
    if (!values || !values.length) return null;
    return this._quantileSorted(values.slice().sort((a, b) => a - b), p);
  },
  // Même quantile sur un tableau DÉJÀ trié : le laboratoire (§3.8) tire
  // plusieurs quantiles de la même série, autant ne trier qu'une fois.
  _quantileSorted(v, p) {
    if (!v || !v.length) return null;
    if (v.length === 1) return v[0];
    const idx = (v.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  },
  _median(values) { return this._quantile(values, 0.5); },

  // Premier index dont `atMs >= t` (les échantillons sont triés par atMs).
  _lowerBound(samples, t) {
    let lo = 0, hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].atMs < t) lo = mid + 1; else hi = mid; }
    return lo;
  },

  /* Fenêtre glissante commune aux deux prédicteurs (§3.2/§3.3) :
     min(`days` jours civils, `max` derniers échantillons), bornée au passé
     connu à `asOfMs`. `samples` doit être trié par `atMs` croissant — d'où
     la recherche dichotomique : le laboratoire (§3.8) rejoue des milliers
     de fenêtres, un balayage linéaire y devient quadratique. */
  _predWindow(samples, asOfMs, days, max) {
    const fromMs = this.startOfDay(this.addDays(new Date(asOfMs), -(days - 1))).getTime();
    const lo = this._lowerBound(samples, fromMs);
    const hi = this._lowerBound(samples, asOfMs + 1);   // futur : jamais visible
    return samples.slice(Math.max(lo, hi - max), hi);
  },

  // Médiane + plage d'une fenêtre d'échantillons. La plage n'apparaît qu'à
  // partir de `minForRange` (P25/P75 sur 2 points ne veut rien dire).
  _predDist(win, minForRange) {
    const vals = win.map(s => s.min), n = vals.length;
    if (!n) return { n: 0, medianMin: null, p25Min: null, p75Min: null };
    const range = n >= minForRange;
    return {
      n, medianMin: this._median(vals),
      p25Min: range ? this._quantile(vals, 0.25) : null,
      p75Min: range ? this._quantile(vals, 0.75) : null,
    };
  },

  /* ---------- Échantillons du prédictif ----------
     Renvoie { startMs, episodes, closed, ongoing, gaps, durations, excluded }.
     `gaps` et `durations` sont triés par `atMs` (instant de connaissance) :
       - écart d'éveil g : atMs = début du dodo suivant, min = éveil mesuré ;
       - durée d        : atMs = fin du dodo, min = durée de l'épisode.
     `ongoing` = dodo en cours (jamais un échantillon : sa durée n'est pas
     encore connue, et l'éveil qui le précède l'est déjà). */
  _predSamples(allEvents, opts = {}) {
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const startMs = (opts.domainStart && opts.domainStart.sommeil)
      ? this.startOfDay(opts.domainStart.sommeil).getTime() : -Infinity;
    const excluded = { avantSuivi: 0, aberrants: 0, chevauchants: 0, eveilTropLong: 0, eveilNegatif: 0 };
    const all = this.sleepEpisodes(allEvents, { nowMs });
    // Dodo en cours = le PLUS RÉCENT sans fin (même critère que activeSleep()
    // dans app.js, qui balaie la liste du plus récent au plus ancien) : l'état
    // affiché reste celui du reste de l'app, même si l'épisode est écarté des
    // échantillons.
    let ongoingRaw = null;
    for (const ep of all) if (ep.ongoing) ongoingRaw = ep;
    const kept = [];
    for (const ep of all) {
      if (ep.startMs < startMs) { excluded.avantSuivi++; continue; }
      if (ep.aberrant) { excluded.aberrants++; continue; }
      if (ep.overlapsPrev) { excluded.chevauchants++; continue; }
      kept.push(ep);
    }
    const closed = kept.filter(ep => !ep.ongoing);
    const durations = closed.map(ep => ({ atMs: ep.endMs, min: (ep.endMs - ep.startMs) / 60000, ep }));
    const gaps = [];
    for (let i = 1; i < kept.length; i++) {
      const prev = kept[i - 1], cur = kept[i];
      if (prev.ongoing) continue;                                     // rien de mesurable derrière un dodo en cours
      const ms = cur.startMs - prev.endMs;
      if (ms < 0) { excluded.eveilNegatif++; continue; }
      if (ms > this.WAKE_GAP_MAX_MS) { excluded.eveilTropLong++; continue; }
      gaps.push({ atMs: cur.startMs, min: ms / 60000, fromMs: prev.endMs, ep: cur });
    }
    return { startMs, episodes: kept, closed, ongoing: ongoingRaw, gaps, durations, excluded };
  },

  /* ---------- Repas : ligne de temps alimentaire ----------
     Primitive pure, au même titre que `sleepEpisodes` : la liste des repas
     triée par instant, pour que le laboratoire (§3.8) puisse TESTER si le
     rythme alimentaire explique quelque chose du sommeil.

     Ce que la saisie donne réellement (voir FORMS dans app.js) :
       - tétée   : `side` et `duration` sont OPTIONNELS, et `duration` est un
                   PRESET tapé (5/10/15/20/30 min) — une étiquette de saisie,
                   pas une mesure ;
       - biberon : `ml` est toujours écrit (défaut 90) ;
       - `ts`    : l'instant du log. Rien dans l'app ne dit s'il est tapé au
                   début ou à la fin du repas, et AUCUNE heure de fin n'est
                   enregistrée.
     Trois conséquences assumées :
       1. on ne fabrique pas de « fin de repas » (`ts + 15 min` serait une
          donnée inventée) : tous les délais partent de l'instant enregistré ;
       2. la durée n'est jamais une caractéristique (quasi constante, et
          quantifiée sur 5 valeurs : elle ne porterait que du bruit de saisie) ;
       3. elle n'est jamais convertie en volume — le volume n'existe que pour
          les biberons. */
  feedTimeline(allEvents, opts = {}) {
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const startMs = (opts.domainStart && opts.domainStart.repas)
      ? this.startOfDay(opts.domainStart.repas).getTime() : -Infinity;
    const out = [];
    for (const e of (allEvents || [])) {
      if (!e || e.deleted) continue;
      if (e.action !== 'tetee' && e.action !== 'biberon') continue;
      const ms = new Date(e.ts).getTime();
      if (!isFinite(ms) || ms < startMs || ms > nowMs) continue;
      const ml = Number(e.data && e.data.ml);
      out.push({
        atMs: ms,
        kind: e.action === 'biberon' ? 'bottle' : 'breast',
        ml: (e.action === 'biberon' && isFinite(ml)) ? ml : null,
      });
    }
    out.sort((a, b) => a.atMs - b.atMs);
    return out;
  },

  /* Caractéristiques alimentaires connues À un instant donné, et rien
     d'ultérieur (`feeds` est trié : on coupe par recherche dichotomique).
     Tout à `null` quand aucun repas n'est connu dans les 12 h précédentes —
     jamais de valeur fabriquée pour combler un trou de saisie. */
  _labFeedFeat(feeds, atMs) {
    const none = { sinceFeedMin: null, feedKind: null, lastBottleMl: null, feeds3h: null, feedCluster: null };
    if (!feeds || !feeds.length) return none;
    const hi = this._lowerBound(feeds, atMs + 1);          // repas connus à `atMs`
    if (!hi) return none;
    const last = feeds[hi - 1];
    const sinceMs = atMs - last.atMs;
    if (sinceMs > this.FEED_SINCE_MAX_MS) return none;     // repas non noté : on ne sait pas
    let n3 = 0;
    for (let i = hi - 1; i >= 0 && atMs - feeds[i].atMs <= this.FEED_CLUSTER_WINDOW_MS; i--) n3++;
    return {
      sinceFeedMin: sinceMs / 60000,
      feedKind: last.kind,
      lastBottleMl: last.kind === 'bottle' ? last.ml : null,
      feeds3h: n3,
      feedCluster: n3 <= 1 ? 'sparse' : (n3 === 2 ? 'steady' : 'cluster'),
    };
  },

  /* Qualité d'un backtest (§3.6) : le RECUL (combien de prédictions vérifiées)
     et la PERFORMANCE (de combien on se trompe) sont deux choses distinctes —
     jamais fusionnées en un « % de confiance ».
     Performance mesurée sur les `tierSolid` derniers backtests ; `tier` sur le
     total accumulé. Résidus signés (réel - prévu) conservés pour calibrer une
     plage ; résidus absolus pour mesurer l'erreur. */
  _predQuality(rows, tierEmerging, tierSolid) {
    const recent = rows.slice(-tierSolid);
    const abs = recent.map(r => Math.abs(r.errMin)), signed = recent.map(r => r.errMin);
    return {
      n: rows.length, recentN: recent.length,
      tier: rows.length >= tierSolid ? 'solide' : (rows.length >= tierEmerging ? 'intermediaire' : 'debut'),
      medAbsMin: this._median(abs),
      p80AbsMin: this._quantile(abs, 0.8),
      medSignedMin: this._median(signed),
      p25SignedMin: this._quantile(signed, 0.25),
      p75SignedMin: this._quantile(signed, 0.75),
      absErrs: abs,
      rows: recent,
    };
  },

  /* L'onglet Prédiction n'a de sens qu'avec au moins un point de donnée sur un
     des deux prédicteurs (§4). Test volontairement LÉGER : il est appelé à
     chaque rendu de la barre d'onglets, là où sleepPrediction() rejoue tous les
     backtests. */
  hasSleepSamples(allEvents, opts = {}) {
    const S = this._predSamples((allEvents || []).filter(e => e && !e.deleted), {
      nowMs: opts.now != null ? new Date(opts.now).getTime() : undefined,
      domainStart: opts.domainStart,
    });
    return S.durations.length > 0 || S.gaps.length > 0;
  },

  /* ---------- Point d'entrée unique du prédictif ----------
     Même contrat d'appel que compute() : Stats.sleepPrediction(Store.all(), {
       now, domainStart: DATA_START, birth }).
     Tout est recalculé à chaque appel (aucun cache, aucune persistance).  */
  sleepPrediction(allEvents, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const nowMs = now.getTime();
    const S = this._predSamples((allEvents || []).filter(e => e && !e.deleted),
      { nowMs, domainStart: opts.domainStart });

    /* ---- Backtests walk-forward (§3.5) ---- */
    const bt1 = [], bt2 = [], btRt = [];
    const medOf = win => this._median(win.map(s => s.min));
    for (const g of S.gaps) {
      const asOf = g.fromMs;                        // la prédiction aurait été faite AU réveil
      const w = this._predWindow(S.gaps, asOf, this.WW_WINDOW_DAYS, this.WW_WINDOW_MAX_SAMPLES);
      if (w.length < this.BACKTEST_MIN_TRAIN_SAMPLES) continue;
      const pred = medOf(w);
      bt1.push({ anchorMs: asOf, predMs: asOf + pred * 60000, realMs: g.atMs, errMin: g.min - pred, trainN: w.length });
    }
    for (const d of S.durations) {
      const asOf = d.ep.startMs;                    // …À l'endormissement
      const w = this._predWindow(S.durations, asOf, this.SD_WINDOW_DAYS, this.SD_WINDOW_MAX_SAMPLES);
      if (w.length < this.SD_BACKTEST_MIN_TRAIN_SAMPLES) continue;
      const pred = medOf(w);
      bt2.push({ anchorMs: asOf, predMs: asOf + pred * 60000, realMs: d.atMs, errMin: d.min - pred, trainN: w.length });
    }
    for (const g of S.gaps) {
      if (g.ep.ongoing) continue;                   // réveil réel encore inconnu
      const asOf = g.fromMs;                        // aller-retour prédit AU réveil précédent
      const w1 = this._predWindow(S.gaps, asOf, this.WW_WINDOW_DAYS, this.WW_WINDOW_MAX_SAMPLES);
      const w2 = this._predWindow(S.durations, asOf, this.SD_WINDOW_DAYS, this.SD_WINDOW_MAX_SAMPLES);
      if (w1.length < this.BACKTEST_MIN_TRAIN_SAMPLES || w2.length < this.SD_BACKTEST_MIN_TRAIN_SAMPLES) continue;
      const predMs = asOf + (medOf(w1) + medOf(w2)) * 60000;
      btRt.push({
        anchorMs: asOf, predMs, realMs: g.ep.endMs,
        errMin: (g.ep.endMs - predMs) / 60000,      // SIGNÉ : + = réveil plus tard que prévu
        trainN: Math.min(w1.length, w2.length),
      });
    }
    const quality1 = this._predQuality(bt1, this.BACKTEST_TIER_EMERGING_N, this.BACKTEST_TIER_SOLID_N);
    const quality2 = this._predQuality(bt2, this.SD_BACKTEST_TIER_EMERGING_N, this.SD_BACKTEST_TIER_SOLID_N);
    const roundtrip = this._predQuality(btRt, this.RT_TIER_EMERGING_N, this.RT_TIER_SOLID_N);

    /* ---- Distributions du moment (mêmes fenêtres, asOf = maintenant) ---- */
    const onset = this._predDist(
      this._predWindow(S.gaps, nowMs, this.WW_WINDOW_DAYS, this.WW_WINDOW_MAX_SAMPLES),
      this.WW_MIN_SAMPLES_FOR_RANGE);
    const duration = this._predDist(
      this._predWindow(S.durations, nowMs, this.SD_WINDOW_DAYS, this.SD_WINDOW_MAX_SAMPLES),
      this.SD_MIN_SAMPLES_FOR_RANGE);
    duration.iqrRatio = (duration.p25Min != null && duration.medianMin > 0)
      ? (duration.p75Min - duration.p25Min) / duration.medianMin : null;
    duration.wide = duration.iqrRatio != null && duration.iqrRatio > this.SD_MAX_IQR_MEDIAN_RATIO;

    /* ---- État et chaînage (§3.4) ---- */
    const lastClosed = S.closed.length ? S.closed[S.closed.length - 1] : null;
    const state = S.ongoing ? 'ASLEEP' : (lastClosed ? 'AWAKE' : 'UNKNOWN');
    let wake = null, sinceMs = null;

    if (state === 'AWAKE') {
      sinceMs = lastClosed.endMs;
      const anchor = lastClosed.endMs;
      if (onset.n) {
        onset.anchorMs = anchor;
        onset.atMs = anchor + onset.medianMin * 60000;
        onset.loMs = onset.p25Min != null ? anchor + onset.p25Min * 60000 : null;
        onset.hiMs = onset.p75Min != null ? anchor + onset.p75Min * 60000 : null;
        if (duration.n) {
          const atMs = onset.atMs + duration.medianMin * 60000;
          if (roundtrip.recentN >= 1) {
            // Plage calibrée sur l'erreur réellement observée de la chaîne.
            wake = { atMs, loMs: atMs + roundtrip.p25SignedMin * 60000, hiMs: atMs + roundtrip.p75SignedMin * 60000, basis: 'roundtrip' };
          } else if (onset.p25Min != null && duration.p25Min != null) {
            // Repli explicite tant qu'aucun aller-retour n'a été vérifié : somme
            // des plages (trop large, à annoncer comme telle).
            wake = {
              atMs, basis: 'somme',
              loMs: anchor + (onset.p25Min + duration.p25Min) * 60000,
              hiMs: anchor + (onset.p75Min + duration.p75Min) * 60000,
            };
          } else {
            wake = { atMs, loMs: null, hiMs: null, basis: 'point' };
          }
        }
      }
    } else if (state === 'ASLEEP') {
      sinceMs = S.ongoing.startMs;
      if (duration.n) {
        const start = S.ongoing.startMs;
        wake = {
          atMs: start + duration.medianMin * 60000, basis: 'duree',
          loMs: duration.p25Min != null ? start + duration.p25Min * 60000 : null,
          hiMs: duration.p75Min != null ? start + duration.p75Min * 60000 : null,
        };
        wake.beyondRange = wake.hiMs != null && nowMs > wake.hiMs;
      }
    }

    /* ---- Contexte (§3.1) ---- */
    const jours = new Set();
    for (const ep of S.episodes) {
      for (const seg of this._splitAtMidnight(ep)) if (seg.dayMs >= S.startMs) jours.add(seg.dayMs);
    }
    const context = {
      ageDays: opts.birth ? Math.round((this.startOfDay(now).getTime() - this.startOfDay(opts.birth).getTime()) / 86400000) : null,
      trackedSleepDays: jours.size,
      episodesN: S.episodes.length,
      lastWakeMs: lastClosed ? lastClosed.endMs : null,
      sleepStartMs: S.ongoing ? S.ongoing.startMs : null,
      excluded: S.excluded,
    };

    return {
      nowMs, state, sinceMs,
      sinceMin: sinceMs != null ? (nowMs - sinceMs) / 60000 : null,
      onset, duration, wake,
      quality1, quality2, roundtrip,
      context,
      ready: onset.n > 0 || duration.n > 0,
    };
  },

  /* =========================================================
     LABORATOIRE Champion / Challengers (§3.8, §3.10, §3.12, §3.14)
     -----------------------------------------------------------
     Philosophie (§3.8) : tout calculer tôt, tout comparer en
     walk-forward, tout montrer, ne rien promouvoir automatiquement.

     M0 est le CHAMPION (le modèle réellement affiché par
     sleepPrediction). M1…M7 et MF1…MF4 sont des CHALLENGERS en
     shadow mode : ils produisent une prédiction et un backtest, sans
     aucun effet sur l'estimation principale.

     Deux familles : M* n'utilise que le sommeil, MF* le rythme des
     repas (§3.8.6). La famille MF est en shadow dès le premier jour,
     au même niveau que la baseline — mais en shadow justement parce
     que M0 est l'expérience contrôle : le jour où l'alimentation
     entrerait dans le modèle affiché, on ne saurait plus dire si le
     prédictif s'est amélioré ou dégradé.

     Trois cibles :
       - `onset`     : endormissement, ancré au dernier réveil réel ;
       - `wake`      : réveil, ancré à l'endormissement réel ;
       - `remaining` : réveil RE-prédit pendant que bébé dort encore.
         La sonde est placée à l'heure que M0 avait annoncée : le cas
         n'existe que si l'épisode a DÉPASSÉ la prédiction de M0
         (exactement la question du checkpoint S6, §3.13). À cette
         sonde, M0 dit « il devrait se réveiller maintenant » alors
         que M2 conditionne la durée restante à `D > elapsedSleep`.
         Les caractéristiques alimentaires y sont volontairement
         nulles : l'ancre est au milieu du dodo, alors que les
         échantillons mesurent les leurs à l'endormissement.

     Aucune fuite du futur : chaque cas ne connaît que les
     échantillons dont `atMs <= asOfMs`. Conséquence exploitée
     ensuite : une vue « telle qu'elle était à S6 » est un simple
     FILTRE `realMs <= S6` sur les cas — jamais un recalcul avec des
     données postérieures (§3.8.4).

     Rien n'est persisté (§3.11) : les statuts, le gel pour
     confirmation et les checkpoints sont redérivés à chaque appel à
     partir de la seule séquence des cas.
     ========================================================= */

  // 1.1 : ajout additif des caractéristiques alimentaires et de la famille MF.
  LAB_SCHEMA_VERSION: 'sleep-prediction-lab/1.1',
  LAB_SUBJECT_ID: 'baby-1',

  // §3.10 — constantes PRODUIT (points de départ ajustables), jamais
  // des frontières biologiques et jamais déduites de l'âge du bébé.
  FEATURE_EXPLORATION_MIN_PAIRED_N: 20,
  FEATURE_CONFIRM_TRIGGER_N: 40,
  FEATURE_MIN_GAIN_MIN_MS: 5 * 60 * 1000,
  FEATURE_CONFIRM_N: 20,
  FEATURE_MAX_CONCURRENT_TRIALS: 2,

  LAB_KNN_K: 5,                 // M4/M5/MF1/MF3 : voisins retenus
  LAB_KNN_MIN_N: 8,             // …et taille mini de la fenêtre pour que « voisin » veuille dire quelque chose
  LAB_MIN_SUBGROUP_N: 5,        // M6/MF2/MF4 : pas de sous-groupe quasi vide
  // Alimentation : mêmes garde-fous que pour l'éveil (WAKE_GAP_MAX_MS) —
  // au-delà, ce n'est plus un jeûne, c'est un repas qu'on a oublié de noter.
  FEED_SINCE_MAX_MS: 12 * 60 * 60 * 1000,
  FEED_CLUSTER_WINDOW_MS: 3 * 60 * 60 * 1000,   // fenêtre du décompte « grappe de repas »
  LAB_WEIGHTED_MIN_N: 8,        // M7 : pondérer 3 points n'a pas de sens
  LAB_HALF_LIFE_H: 72,          // M7 : demi-vie de la pondération par récence
  LAB_RECENT_N: 40,             // fenêtre « recent40 » des métriques
  LAB_RECENT_SHORT_N: 10,       // « 10 derniers cas » (informatif, très volatil)
  LAB_CHECKPOINT_WEEKS: [3, 4, 6, 8, 10, 12, 16],
  LAB_CHECKPOINT_EVERY_WEEKS: 4,
  // §3.13 — un checkpoint est un rendez-vous de LECTURE : il dit « regarde
  // maintenant ce que les données racontent », il ne démarre aucun modèle
  // (tout ce qui est calculable l'est déjà avant).
  LAB_CHECKPOINT_FOCUS: {
    3: { label: 'Checkpoint alimentation', models: ['MF1', 'MF2', 'MF3', 'MF4'], watch: 'le rythme des repas explique-t-il quelque chose que l’heure et l’historique n’expliquent pas déjà ? regarder les cas où le rythme casse (grappe de repas, jeûne inhabituel), pas la moyenne' },
    4: { label: 'Checkpoint récence', models: ['M1'], watch: 'les variantes de fenêtre divergent-elles enfin ? gain M1 vs M0, stabilité sur les derniers cas' },
    6: { label: 'Checkpoint ASLEEP', models: ['M2'], watch: 'le sommeil restant améliore-t-il le réveil, surtout quand M0 a déjà été dépassé ?' },
    8: { label: 'Checkpoint heure', models: ['M3'], watch: 'le gain du contexte horaire devient-il positif et stable ? existe-t-il surtout sur certaines tranches ?' },
    10: { label: 'Checkpoint mémoire courte', models: ['M4', 'M5'], watch: 'épisode précédent : gain endormissement/réveil, cas où il aide ou dégrade' },
    12: { label: 'Checkpoint structure', models: ['M6'], watch: 'une segmentation jour/nuit devient-elle réellement utile ?' },
    16: { label: 'Checkpoint récence adaptative', models: ['M7'], watch: 'une pondération robuste bat-elle les fenêtres fixes ?' },
  },
  LAB_CHECKPOINT_GENERAL: { label: 'Revue générale', models: null, watch: 'champion vs challengers, dérive, candidats à retester — ne pas complexifier sans amélioration nette' },
  LAB_STATUS_ORDER: ['collecting', 'shadow', 'exploration', 'confirming', 'active', 'rejected'],
  LAB_TARGETS: [
    { key: 'onset', label: 'Endormissement', hint: 'ancré au dernier réveil réel' },
    { key: 'wake', label: 'Réveil', hint: 'ancré à l’endormissement réel' },
    { key: 'remaining', label: 'Réveil pendant le sommeil', hint: 'ré-estimation quand M0 est dépassé' },
  ],

  _labMinTrain(target) {
    return target === 'onset' ? this.BACKTEST_MIN_TRAIN_SAMPLES : this.SD_BACKTEST_MIN_TRAIN_SAMPLES;
  },
  // Fenêtre glissante du modèle : le POOL dépend de la cible
  // (écarts d'éveil pour `onset`, durées de sommeil pour les deux autres).
  _labWindow(c, days, max) {
    return this._predWindow(c.target === 'onset' ? c.S.gaps : c.S.durations, c.asOfMs, days, max);
  },
  _labFeat(c, s) { return c.featMap.get(s) || {}; },
  _localHour(ms) { const d = new Date(ms); return Math.round((d.getHours() + d.getMinutes() / 60) * 100) / 100; },
  _labSlot(h) {
    if (h == null) return null;
    return h < 6 ? 'nuit' : (h < 12 ? 'matin' : (h < 18 ? 'aprem' : 'soir'));
  },
  _labIsNight(h) { return h == null ? null : (h >= 20 || h < 7); },

  // Médiane des `LAB_KNN_K` échantillons dont la feature est la plus
  // proche de celle du cas. Aucune valeur fabriquée : si la feature du
  // cas est inconnue ou la fenêtre trop courte → null (« non applicable »).
  _labKnn(c, win, key) {
    const f0 = c.features[key];
    if (f0 == null) return null;
    const pts = win.map(s => ({ v: s.min, f: this._labFeat(c, s)[key] })).filter(p => p.f != null);
    if (pts.length < this.LAB_KNN_MIN_N) return null;
    pts.sort((a, b) => Math.abs(a.f - f0) - Math.abs(b.f - f0));
    return this._median(pts.slice(0, this.LAB_KNN_K).map(p => p.v));
  },
  // Médiane pondérée (poids > 0). Robuste comme la médiane, mais donne
  // plus d'importance aux échantillons récents (M7).
  _weightedMedian(pairs) {
    const p = (pairs || []).filter(x => x && x.w > 0 && isFinite(x.v)).sort((a, b) => a.v - b.v);
    if (!p.length) return null;
    const tot = p.reduce((s, x) => s + x.w, 0);
    let cum = 0;
    for (let i = 0; i < p.length; i++) {
      cum += p[i].w;
      if (cum > tot / 2) return p[i].v;
      if (cum === tot / 2) return i + 1 < p.length ? (p[i].v + p[i + 1].v) / 2 : p[i].v;
    }
    return p[p.length - 1].v;
  },

  /* ---------- Catalogue (§3.12) ----------
     Chaque modèle déclare id, label, version, targets[], features[],
     parameters — le même langage pour l'UI, les snapshots et l'export.
     `predict(ctx)` rend des MINUTES depuis `ctx.anchorMs`, ou null quand
     le modèle ne sait rien dire (jamais une valeur fabriquée). */
  LAB_MODELS: [
    {
      id: 'M0', label: 'Baseline récente', version: 1, champion: true,
      targets: ['onset', 'wake', 'remaining'], features: ['recentHistory'],
      parameters: { windowDays: 14, windowMaxSamples: 40, statistic: 'median' },
      note: 'Médiane sur fenêtre 14 j / 40 échantillons — le modèle réellement affiché.',
      predict(c) {
        const w = this._labWindow(c, 14, 40);
        if (w.length < this._labMinTrain(c.target)) return null;
        const med = this._median(w.map(s => s.min));
        // ASLEEP : la baseline reste ancrée à l'endormissement réel
        // (`actualSleepStart + médiane(D)`), elle ne se ré-estime pas.
        return c.target === 'remaining' ? med - c.features.elapsedSleepMin : med;
      },
    },
    {
      id: 'M1', label: 'Récence / fenêtre courte', version: 1, requiresDivergence: true,
      targets: ['onset', 'wake'], features: ['recentHistory'],
      parameters: { windowDays: 7, windowMaxSamples: 10, statistic: 'median' },
      note: 'Même statistique que M0 sur une fenêtre plus courte (7 j / 10 cas) : reste en collecte tant que les deux fenêtres donnent la même chose.',
      predict(c) {
        const w = this._labWindow(c, 7, 10);
        if (w.length < this._labMinTrain(c.target)) return null;
        return this._median(w.map(s => s.min));
      },
    },
    {
      id: 'M2', label: 'Sommeil restant', version: 1,
      targets: ['remaining'], features: ['recentHistory', 'elapsedSleepMin'],
      parameters: { windowDays: 14, windowMaxSamples: 40, conditional: 'D > elapsedSleep' },
      note: 'Conditionne la durée restante au fait que bébé dort encore : ne garde que les dodos historiques plus longs que le temps déjà écoulé.',
      predict(c) {
        const w = this._labWindow(c, 14, 40);
        if (w.length < this.SD_BACKTEST_MIN_TRAIN_SAMPLES) return null;
        const longer = w.map(s => s.min).filter(v => v > c.features.elapsedSleepMin);
        if (!longer.length) return null;          // aucun précédent plus long : rien à dire
        return this._median(longer) - c.features.elapsedSleepMin;
      },
    },
    {
      id: 'M3', label: 'Contexte horaire', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'localHour'],
      parameters: { windowDays: 14, windowMaxSamples: 40, slots: ['nuit 0-6', 'matin 6-12', 'aprem 12-18', 'soir 18-24'] },
      note: 'Médiane restreinte à la même tranche horaire que le cas.',
      predict(c) {
        const slot = this._labSlot(c.features.localHour);
        if (!slot) return null;
        const w = this._labWindow(c, 14, 40).filter(s => this._labSlot(this._labFeat(c, s).localHour) === slot);
        if (w.length < this._labMinTrain(c.target)) return null;
        return this._median(w.map(s => s.min));
      },
    },
    {
      id: 'M4', label: 'Sommeil précédent', version: 1,
      targets: ['onset'], features: ['recentHistory', 'previousSleepDurationMin'],
      parameters: { windowDays: 14, windowMaxSamples: 40, neighbours: 5 },
      note: 'Médiane des écarts d’éveil observés après un dodo de durée comparable (5 plus proches voisins).',
      predict(c) {
        return this._labKnn(c, this._labWindow(c, 14, 40), 'prevSleepMin');
      },
    },
    {
      id: 'M5', label: 'Éveil précédent', version: 1,
      targets: ['wake'], features: ['recentHistory', 'previousWakeDurationMin'],
      parameters: { windowDays: 14, windowMaxSamples: 40, neighbours: 5 },
      note: 'Médiane des durées de sommeil observées après un éveil de durée comparable (5 plus proches voisins).',
      predict(c) {
        return this._labKnn(c, this._labWindow(c, 14, 40), 'prevWakeMin');
      },
    },
    {
      id: 'M6', label: 'Structure jour / nuit', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'dayNight'],
      parameters: { windowDays: 14, windowMaxSamples: 40, night: '20h→7h', minPerGroup: 5 },
      note: 'Segmentation jour/nuit uniquement : aucun indice de sieste WW1/WW2/WW3 imposé par l’âge (§3.11).',
      predict(c) {
        const night = this._labIsNight(c.features.localHour);
        if (night == null) return null;
        const w = this._labWindow(c, 14, 40).filter(s => this._labIsNight(this._labFeat(c, s).localHour) === night);
        if (w.length < this.LAB_MIN_SUBGROUP_N) return null;   // pas de sous-groupe quasi vide
        return this._median(w.map(s => s.min));
      },
    },
    {
      id: 'M7', label: 'Récence pondérée', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'recencyWeight'],
      parameters: { windowDays: 28, windowMaxSamples: 80, halfLifeHours: 72, statistic: 'weightedMedian' },
      note: 'Médiane pondérée par récence (demi-vie 72 h) sur un historique plus profond : teste si pondérer bat une fenêtre fixe.',
      predict(c) {
        const w = this._labWindow(c, 28, 80);
        if (w.length < this.LAB_WEIGHTED_MIN_N) return null;
        const hl = this.LAB_HALF_LIFE_H * 3600 * 1000;
        return this._weightedMedian(w.map(s => ({ v: s.min, w: Math.pow(2, -(c.asOfMs - s.atMs) / hl) })));
      },
    },
    /* ---- Famille MF : rythme des repas (§3.8.6) ----
       Montée au rang de challenger dès le premier jour, au même niveau que la
       baseline — mais en SHADOW : M0 est l'expérience contrôle, l'alimentation
       n'entre pas dans le modèle affiché, et aucune règle du genre « repas
       terminé → retrancher 20 min » n'est codée en dur : elle passerait devant
       le backtest sans être démontrée.

       Deux cibles seulement (`onset`, `wake`) : ce sont celles où la
       caractéristique du cas et celle des échantillons se mesurent au même
       genre d'instant (le réveil, l'endormissement). Sur les sondes, l'ancre
       est au milieu de l'épisode et la comparaison n'aurait pas de sens.

       Piège de lecture, à garder en tête devant les gains : plus le rythme est
       régulier, plus « temps depuis le repas » et « temps depuis le réveil »
       (M0) sont colinéaires. Un gain ne peut donc apparaître que là où le
       rythme CASSE — cluster feeding, poussée de croissance. C'est là qu'il
       faut regarder, pas sur la moyenne globale. */
    {
      id: 'MF1', label: 'Délai depuis le dernier repas', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'minutesSinceLastFeed'],
      parameters: { windowDays: 14, windowMaxSamples: 40, neighbours: 5, maxSinceHours: 12 },
      note: 'Médiane des cas observés après un délai comparable depuis le dernier repas noté (5 plus proches voisins). Sur la durée de sommeil, c’est le délai repas → endormissement.',
      predict(c) {
        return this._labKnn(c, this._labWindow(c, 14, 40), 'sinceFeedMin');
      },
    },
    {
      id: 'MF2', label: 'Type du dernier repas', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'lastFeedKind'],
      parameters: { windowDays: 14, windowMaxSamples: 40, groups: ['breast', 'bottle'], minPerGroup: 5 },
      note: 'Médiane restreinte aux cas dont le dernier repas était du même type (sein / biberon). La durée d’une tétée n’intervient jamais : c’est un preset saisi, pas une mesure.',
      predict(c) {
        const kind = c.features.feedKind;
        if (!kind) return null;
        const w = this._labWindow(c, 14, 40).filter(s => this._labFeat(c, s).feedKind === kind);
        if (w.length < this.LAB_MIN_SUBGROUP_N) return null;
        return this._median(w.map(s => s.min));
      },
    },
    {
      id: 'MF3', label: 'Volume du dernier biberon', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'lastBottleMl'],
      parameters: { windowDays: 14, windowMaxSamples: 40, neighbours: 5, bottlesOnly: true },
      note: 'Médiane des cas observés après un biberon de volume comparable (5 plus proches voisins). Ne dit rien quand le dernier repas était une tétée : le volume n’existe pas — aucune conversion depuis la durée. Teste « gros repas → long sommeil » au lieu de le supposer.',
      predict(c) {
        return this._labKnn(c, this._labWindow(c, 14, 40), 'lastBottleMl');
      },
    },
    {
      id: 'MF4', label: 'Grappe de repas (3 h)', version: 1,
      targets: ['onset', 'wake'], features: ['recentHistory', 'feedCluster'],
      parameters: { windowDays: 14, windowMaxSamples: 40, windowHours: 3, groups: ['sparse ≤1', 'steady 2', 'cluster ≥3'], minPerGroup: 5 },
      note: 'Médiane restreinte aux cas ayant le même profil de repas sur les 3 h précédentes : c’est le rythme qui est testé, pas le dernier repas seul — donc les soirées de cluster feeding.',
      predict(c) {
        const cl = c.features.feedCluster;
        if (!cl) return null;
        const w = this._labWindow(c, 14, 40).filter(s => this._labFeat(c, s).feedCluster === cl);
        if (w.length < this.LAB_MIN_SUBGROUP_N) return null;
        return this._median(w.map(s => s.min));
      },
    },
    {
      id: 'M8', label: 'Hybride ciblé', version: 0,
      targets: [], features: [], parameters: {},
      predict: null,
      blocked: 'Non instancié : un modèle combiné ne se crée qu’après avoir lu et compris les effets simples (§3.8.6), sinon le gain n’est plus attribuable.',
      note: 'Placeholder de discipline d’attribution — une modification à la fois contre M0 (§3.10). Premier candidat en attente : la position du repas dans la fenêtre d’éveil, `1 − sinceFeedMin / prevWakeMin`, qui combine deux caractéristiques déjà testées séparément (MF1 et M5) — donc à n’instancier qu’après avoir lu leurs effets simples.',
    },
  ],

  _labChampion() { return this.LAB_MODELS.find(m => m.champion) || this.LAB_MODELS[0]; },
  _labModel(id) { return this.LAB_MODELS.find(m => m.id === id) || null; },

  /* Index des épisodes : donne les features connues AVANT le résultat. */
  _labIndex(S) {
    const eps = S.episodes;
    const idx = new Map();
    eps.forEach((ep, i) => idx.set(ep, i));
    const dur = ep => (ep && !ep.ongoing) ? (ep.endMs - ep.startMs) / 60000 : null;
    const prevOf = ep => { const i = idx.get(ep); return (i == null || i < 1) ? null : eps[i - 1]; };
    const wakeBefore = ep => {
      const prev = prevOf(ep);
      if (!prev || prev.ongoing) return null;
      const ms = ep.startMs - prev.endMs;
      return (ms < 0 || ms > this.WAKE_GAP_MAX_MS) ? null : ms / 60000;
    };
    return { dur, prevOf, wakeBefore };
  },

  /* Features de chaque échantillon d'entraînement, mêmes définitions que
     celles des cas (sinon un k-NN comparerait des choux et des carottes). */
  _labFeatMap(S, ix, feeds) {
    const map = new Map();
    for (const s of S.gaps) {
      const prev = ix.prevOf(s.ep);                        // dodo qui vient de finir
      map.set(s, {
        localHour: this._localHour(s.fromMs),
        prevSleepMin: ix.dur(prev),
        prevWakeMin: prev ? ix.wakeBefore(prev) : null,
        // Repas mesurés à l'ANCRE de l'échantillon — le réveil pour un écart
        // d'éveil, l'endormissement pour une durée : exactement l'instant où
        // le cas correspondant mesure les siennes.
        ...this._labFeedFeat(feeds, s.fromMs),
      });
    }
    for (const s of S.durations) {
      map.set(s, {
        localHour: this._localHour(s.ep.startMs),
        prevSleepMin: ix.dur(ix.prevOf(s.ep)),
        prevWakeMin: ix.wakeBefore(s.ep),
        ...this._labFeedFeat(feeds, s.ep.startMs),
      });
    }
    return map;
  },

  _labAgeDays(ms, birthMs) {
    if (birthMs == null) return null;
    return Math.round((this.startOfDay(new Date(ms)).getTime() - birthMs) / 86400000);
  },

  /* ---------- Cas walk-forward ---------- */
  _labCases(S, ix, birthMs, feeds) {
    const out = [];
    // Numérotation PAR CIBLE et dans l'ordre chronologique de création : un
    // cas garde le même identifiant d'un export à l'autre (ajouter des dodos
    // ne renumérote rien), sinon deux analyses successives ne parleraient pas
    // du même `wake-0042`.
    const seq = { onset: 0, wake: 0, remaining: 0 };
    const push = (target, asOfMs, anchorMs, realMs, realMin, features) => {
      out.push({
        id: `${target}-${String(++seq[target]).padStart(4, '0')}`,
        target, asOfMs, anchorMs, realMs, realMin,
        ageDays: this._labAgeDays(anchorMs, birthMs),
        features, preds: {},
      });
    };

    for (const g of S.gaps) {
      const prev = ix.prevOf(g.ep);
      push('onset', g.fromMs, g.fromMs, g.atMs, g.min, {
        localHour: this._localHour(g.fromMs),
        prevSleepMin: ix.dur(prev),
        prevWakeMin: prev ? ix.wakeBefore(prev) : null,
        elapsedSleepMin: null,
        // Depuis combien de temps bébé n'avait-il pas mangé au moment où il
        // s'est réveillé ? (le repas qui suit ce réveil n'existe pas encore
        // pour ce cas : ce serait une fuite du futur)
        ...this._labFeedFeat(feeds, g.fromMs),
      });
    }
    for (const d of S.durations) {
      push('wake', d.ep.startMs, d.ep.startMs, d.atMs, d.min, {
        localHour: this._localHour(d.ep.startMs),
        prevSleepMin: ix.dur(ix.prevOf(d.ep)),
        prevWakeMin: ix.wakeBefore(d.ep),
        elapsedSleepMin: 0,
        // `sinceFeedMin` ici = délai entre le dernier repas noté et
        // l'endormissement : entièrement dans le passé de l'ancre.
        ...this._labFeedFeat(feeds, d.ep.startMs),
      });
      // Sonde `remaining` : à l'heure que M0 annonçait, si bébé dormait encore.
      const w = this._predWindow(S.durations, d.ep.startMs, this.SD_WINDOW_DAYS, this.SD_WINDOW_MAX_SAMPLES);
      if (w.length < this.SD_BACKTEST_MIN_TRAIN_SAMPLES) continue;
      const probeMs = d.ep.startMs + this._median(w.map(s => s.min)) * 60000;
      if (probeMs >= d.atMs) continue;              // M0 n'a pas été dépassé : rien à ré-estimer
      push('remaining', probeMs, probeMs, d.atMs, (d.atMs - probeMs) / 60000, {
        localHour: this._localHour(d.ep.startMs),
        prevSleepMin: ix.dur(ix.prevOf(d.ep)),
        prevWakeMin: ix.wakeBefore(d.ep),
        elapsedSleepMin: (probeMs - d.ep.startMs) / 60000,
        // Repas VOLONTAIREMENT nuls sur la sonde : ici l'ancre est au milieu du
        // dodo, alors que les échantillons d'entraînement mesurent leurs
        // caractéristiques alimentaires à l'endormissement. Les renseigner
        // laisserait croire qu'on peut les comparer aux deux autres cibles —
        // ce serait exactement le k-NN « choux et carottes » de _labFeatMap.
        ...this._labFeedFeat(null, probeMs),
      });
    }
    out.sort((a, b) => a.realMs - b.realMs || (a.id < b.id ? -1 : 1));
    return out;
  },

  // Prédiction de tous les modèles sur un cas (ou sur un pseudo-cas
  // « maintenant », qui n'a pas de vérité connue).
  _labPredictCase(c, S, featMap) {
    const ctx = {
      target: c.target, asOfMs: c.asOfMs, anchorMs: c.anchorMs,
      features: c.features, S, featMap,
    };
    const out = {};
    for (const m of this.LAB_MODELS) {
      if (!m.predict || !m.targets.includes(c.target)) continue;
      let predMin = null;
      try { predMin = m.predict.call(this, ctx); } catch { predMin = null; }
      if (predMin == null || !isFinite(predMin)) continue;
      const predMs = c.anchorMs + predMin * 60000;
      out[m.id] = { predMin, predMs };
    }
    return out;
  },

  /* ---------- Métriques (§3.8.2) ---------- */
  _labPerf(rows, id) {
    const recent = rows.slice(-this.LAB_RECENT_N);
    const abs = recent.map(c => c.preds[id].absErrMin);
    const signed = recent.map(c => c.preds[id].signedErrMin);
    return {
      n: rows.length, recentN: recent.length,
      tier: rows.length >= this.BACKTEST_TIER_SOLID_N ? 'solide'
        : (rows.length >= this.BACKTEST_TIER_EMERGING_N ? 'intermediaire' : 'debut'),
      medAbsMin: this._median(abs),
      p80AbsMin: this._quantile(abs, 0.8),
      medSignedMin: this._median(signed),
    };
  },

  /* Comparaison APPARIÉE (§3.10) — toujours sur les mêmes cas :
       abs0_i = |réel_i − pred_M0_i|
       absx_i = |réel_i − pred_Mx_i|
       gain_i = abs0_i − absx_i          (> 0 = le challenger est meilleur)
       biasx_i = réel_i − pred_Mx_i      (> 0 = le réel arrive plus tard)
     Le taux de victoire est DESCRIPTIF : jamais un test statistique,
     jamais un critère de promotion à lui seul. */
  _labPaired(known, id, target) {
    const ch = this._labChampion().id;
    const rows = known.filter(c => c.target === target && c.preds[id] && c.preds[ch]);
    const gains = rows.map(c => c.preds[ch].absErrMin - c.preds[id].absErrMin);
    const eps = 1e-9;
    const short = gains.slice(-this.LAB_RECENT_SHORT_N);
    // Une seule passe de tri par série, puis autant de quantiles qu'on veut.
    const q = arr => { const v = arr.slice().sort((a, b) => a - b); return p => this._quantileSorted(v, p); };
    const qg = q(gains), qx = q(rows.map(c => c.preds[id].absErrMin));
    const out = {
      pairedN: rows.length,
      medianGainMin: qg(0.5),
      p25GainMin: gains.length >= 3 ? qg(0.25) : null,
      p75GainMin: gains.length >= 3 ? qg(0.75) : null,
      wins: gains.filter(g => g > eps).length,
      ties: gains.filter(g => Math.abs(g) <= eps).length,
      losses: gains.filter(g => g < -eps).length,
      recentShortN: short.length,
      recentShortMedianGainMin: this._median(short),
      championMedAbsMin: this._median(rows.map(c => c.preds[ch].absErrMin)),
      challengerMedAbsMin: qx(0.5),
      challengerP80AbsMin: qx(0.8),
      challengerMedSignedMin: this._median(rows.map(c => c.preds[id].signedErrMin)),
      diverged: rows.some(c => Math.abs(c.preds[id].predMin - c.preds[ch].predMin) > eps),
      firstComparableMs: rows.length ? rows[0].realMs : null,
      firstComparableAgeDays: rows.length ? rows[0].ageDays : null,
      freezeAt: null, freezeMs: null,
      exploration: null, confirmation: null,
    };

    /* Exploration → confirmation (§3.10). Le GEL est mécanique et
       séquentiel (donc reconstructible à n'importe quelle date passée) ;
       la PROMOTION, elle, reste une décision humaine : aucun modèle ne
       devient `active` tout seul. */
    const minGain = this.FEATURE_MIN_GAIN_MIN_MS / 60000;
    if (gains.length >= this.FEATURE_CONFIRM_TRIGGER_N) {
      // Médiane courante mise à jour par insertion triée : re-trier le bloc
      // exploratoire à chaque cas rendrait le laboratoire quadratique.
      const sorted = [];
      for (let i = 0; i < gains.length; i++) {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < gains[i]) lo = mid + 1; else hi = mid; }
        sorted.splice(lo, 0, gains[i]);
        if (i < this.FEATURE_CONFIRM_TRIGGER_N - 1) continue;
        const k = sorted.length;
        const med = k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
        if (med >= minGain) { out.freezeAt = i; break; }
      }
    }
    if (out.freezeAt != null) {
      const expl = gains.slice(0, out.freezeAt + 1), conf = gains.slice(out.freezeAt + 1);
      out.freezeMs = rows[out.freezeAt].realMs;
      out.exploration = { pairedN: expl.length, medianGainMin: this._median(expl) };
      out.confirmation = {
        targetN: this.FEATURE_CONFIRM_N, currentN: conf.length,
        medianGainMin: this._median(conf),
        complete: conf.length >= this.FEATURE_CONFIRM_N,
      };
    }
    return out;
  },

  /* ---------- Vue du laboratoire à une date donnée (§3.8.4) ----------
     `asOfMs` filtre les cas sur `realMs` : ce qu'on savait vraiment ce
     jour-là. Aucune ré-estimation n'a lieu ici — les prédictions ont
     déjà été faites en walk-forward, donc « S6 » ne peut pas emprunter
     un modèle entraîné avec les données de S10. */
  _labView(cases, asOfMs) {
    const known = cases.filter(c => c.realMs <= asOfMs);
    const ch = this._labChampion().id;
    const perf = {}, paired = {}, status = {}, byTarget = {};

    for (const m of this.LAB_MODELS) {
      perf[m.id] = {}; paired[m.id] = {}; byTarget[m.id] = {};
      for (const t of m.targets) {
        const rows = known.filter(c => c.target === t && c.preds[m.id]);
        perf[m.id][t] = this._labPerf(rows, m.id);
        if (m.id !== ch) paired[m.id][t] = this._labPaired(known, m.id, t);
      }
    }

    // Statut par expérience (modèle × cible), puis statut du modèle =
    // le plus avancé de ses expériences. Jamais déduit de l'âge (§3.10).
    const frozen = [];
    for (const m of this.LAB_MODELS) {
      for (const t of m.targets) {
        const p = paired[m.id][t];
        let st = 'collecting', why = '';
        if (m.id === ch) { st = 'active'; why = 'Champion : c’est lui qui est affiché.'; }
        else if (!m.predict) { st = 'collecting'; why = m.blocked || ''; }
        else if (!p || !p.pairedN) { st = 'collecting'; why = 'Aucun cas comparable à M0 pour l’instant.'; }
        else if (m.requiresDivergence && !p.diverged) { st = 'collecting'; why = 'Les deux fenêtres donnent encore exactement la même prédiction.'; }
        else if (p.pairedN < this.FEATURE_EXPLORATION_MIN_PAIRED_N) { st = 'shadow'; why = `${p.pairedN} cas appariés : trop peu pour lire un signal (seuil ${this.FEATURE_EXPLORATION_MIN_PAIRED_N}).`; }
        else if (p.freezeAt != null) { st = 'confirming'; why = 'Gelé pour confirmation sur un bloc de cas non recouvrant.'; }
        else { st = 'exploration'; why = 'Assez de cas appariés pour lire un signal — résultat exploratoire.'; }
        byTarget[m.id][t] = { status: st, why, queued: false };
        if (st === 'confirming') frozen.push({ id: m.id, target: t, freezeMs: p.freezeMs });
      }
    }
    // §3.10 : au plus FEATURE_MAX_CONCURRENT_TRIALS blocs de confirmation
    // en parallèle ; les suivants restent en exploration, en file d'attente.
    frozen.sort((a, b) => a.freezeMs - b.freezeMs || (a.id < b.id ? -1 : 1));
    frozen.slice(this.FEATURE_MAX_CONCURRENT_TRIALS).forEach(f => {
      byTarget[f.id][f.target] = {
        status: 'exploration', queued: true,
        why: `En file d’attente : ${this.FEATURE_MAX_CONCURRENT_TRIALS} confirmations simultanées au maximum.`,
      };
    });

    const rank = s => this.LAB_STATUS_ORDER.indexOf(s);
    for (const m of this.LAB_MODELS) {
      const sts = m.targets.map(t => byTarget[m.id][t].status);
      status[m.id] = sts.length ? sts.reduce((a, b) => rank(b) > rank(a) ? b : a) : 'collecting';
      if (m.id === ch) status[m.id] = 'active';
    }

    return { asOfMs, casesN: known.length, perf, paired, byTarget, status };
  },

  /* ---------- Évolution par semaine d'âge (§3.8.3) ----------
     Chaque ligne ne contient que les cas de SA semaine, tous prédits en
     walk-forward : une valeur affichée à S6 n'utilise donc aucune
     observation postérieure à S6. */
  _labWeekly(cases, asOfMs) {
    const ch = this._labChampion().id;
    const known = cases.filter(c => c.realMs <= asOfMs && c.ageDays != null);
    const rows = [];
    for (const m of this.LAB_MODELS) {
      if (m.id === ch || !m.predict) continue;
      for (const t of m.targets) {
        const byWeek = new Map();
        for (const c of known) {
          if (c.target !== t || !c.preds[m.id] || !c.preds[ch]) continue;
          const wk = Math.floor(c.ageDays / 7);
          if (!byWeek.has(wk)) byWeek.set(wk, []);
          byWeek.get(wk).push(c);
        }
        [...byWeek.keys()].sort((a, b) => a - b).forEach(wk => {
          const cs = byWeek.get(wk);
          rows.push({
            ageWeek: wk, challengerId: m.id, championId: ch, target: t,
            pairedN: cs.length,
            championMedAbsMin: this._median(cs.map(c => c.preds[ch].absErrMin)),
            challengerMedAbsMin: this._median(cs.map(c => c.preds[m.id].absErrMin)),
            challengerP80AbsMin: this._quantile(cs.map(c => c.preds[m.id].absErrMin), 0.8),
            medianGainMin: this._median(cs.map(c => c.preds[ch].absErrMin - c.preds[m.id].absErrMin)),
            challengerMedSignedMin: this._median(cs.map(c => c.preds[m.id].signedErrMin)),
          });
        });
      }
    }
    return rows;
  },

  /* ---------- Checkpoints de LECTURE (§3.13) ----------
     Des rendez-vous de lecture, pas des dates de démarrage de modèle :
     tout ce qui est calculable l'est déjà avant. */
  _labCheckpoints(cases, nowMs, birthMs) {
    if (birthMs == null) return [];
    const ageDays = this._labAgeDays(nowMs, birthMs);
    const weeks = this.LAB_CHECKPOINT_WEEKS.slice();
    const every = this.LAB_CHECKPOINT_EVERY_WEEKS;
    for (let w = weeks[weeks.length - 1] + every; w <= Math.floor(ageDays / 7) + every; w += every) weeks.push(w);
    const challengers = this.LAB_MODELS.filter(m => !m.champion).map(m => m.id);
    const out = [{
      key: 'now', label: 'Aujourd’hui', week: null, dateMs: nowMs, future: false,
      focus: 'État courant', focusModels: challengers, watch: this.LAB_CHECKPOINT_GENERAL.watch,
    }];
    for (const w of weeks) {
      const dateMs = this.startOfDay(this.addDays(new Date(birthMs), w * 7)).getTime();
      const f = this.LAB_CHECKPOINT_FOCUS[w] || this.LAB_CHECKPOINT_GENERAL;
      out.push({
        key: `S${w}`, label: `S${w}`, week: w, dateMs, future: dateMs > nowMs,
        focus: f.label, focusModels: f.models ? f.models.slice() : challengers, watch: f.watch,
      });
    }
    return out;
  },

  /* ---------- Point d'entrée du laboratoire ----------
     Stats.sleepLab(Store.all(), { now, domainStart: DATA_START, birth }).
     Tout est recalculé, rien n'est persisté (§3.11). */
  sleepLab(allEvents, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const nowMs = now.getTime();
    const birthMs = opts.birth ? this.startOfDay(opts.birth).getTime() : null;
    const S = this._predSamples((allEvents || []).filter(e => e && !e.deleted),
      { nowMs, domainStart: opts.domainStart });
    const ix = this._labIndex(S);
    const feeds = this.feedTimeline(allEvents, { nowMs, domainStart: opts.domainStart });
    const featMap = this._labFeatMap(S, ix, feeds);

    const cases = this._labCases(S, ix, birthMs, feeds);
    for (const c of cases) {
      const preds = this._labPredictCase(c, S, featMap);
      for (const id of Object.keys(preds)) {
        const signedErrMin = (c.realMs - preds[id].predMs) / 60000;
        c.preds[id] = { ...preds[id], signedErrMin, absErrMin: Math.abs(signedErrMin) };
      }
    }

    const view = this._labView(cases, nowMs);
    const weekly = this._labWeekly(cases, nowMs);
    const checkpoints = this._labCheckpoints(cases, nowMs, birthMs).map(cp => ({
      ...cp,
      view: cp.future ? null : (cp.key === 'now' ? view : this._labView(cases, cp.dateMs)),
    }));

    /* ---- Vue « Maintenant » (§3.8.1) : les modèles pensent-ils
       différemment ? Un écart ne dit PAS lequel a raison. ---- */
    const lastClosed = S.closed.length ? S.closed[S.closed.length - 1] : null;
    const state = S.ongoing ? 'ASLEEP' : (lastClosed ? 'AWAKE' : 'UNKNOWN');
    const nowCases = [];
    if (state === 'AWAKE') {
      nowCases.push({
        target: 'onset', asOfMs: nowMs, anchorMs: lastClosed.endMs,
        features: {
          localHour: this._localHour(lastClosed.endMs),
          prevSleepMin: ix.dur(lastClosed),
          prevWakeMin: ix.wakeBefore(lastClosed),
          elapsedSleepMin: null,
          // Repas mesurés au RÉVEIL, pas à `nowMs` : c'est la définition que
          // le backtest a validée. Un repas pris depuis le réveil ne peut
          // donc pas entrer ici — il n'entrerait dans aucun cas backtesté,
          // et la prédiction affichée cesserait d'être celle qu'on mesure.
          ...this._labFeedFeat(feeds, lastClosed.endMs),
        },
      });
    } else if (state === 'ASLEEP') {
      const start = S.ongoing.startMs;
      nowCases.push({
        target: 'wake', asOfMs: nowMs, anchorMs: start,
        features: {
          localHour: this._localHour(start),
          prevSleepMin: ix.dur(ix.prevOf(S.ongoing)),
          prevWakeMin: ix.wakeBefore(S.ongoing),
          elapsedSleepMin: 0,
          ...this._labFeedFeat(feeds, start),        // délai repas → endormissement
        },
      });
      nowCases.push({
        target: 'remaining', asOfMs: nowMs, anchorMs: nowMs,
        features: {
          localHour: this._localHour(start),
          prevSleepMin: ix.dur(ix.prevOf(S.ongoing)),
          prevWakeMin: ix.wakeBefore(S.ongoing),
          elapsedSleepMin: (nowMs - start) / 60000,
          ...this._labFeedFeat(null, nowMs),         // cf. _labCases : nuls sur la sonde
        },
      });
    }
    const ch = this._labChampion().id;
    const nowRows = [];
    for (const nc of nowCases) {
      const preds = this._labPredictCase(nc, S, featMap);
      const refMs = preds[ch] ? preds[ch].predMs : null;
      for (const m of this.LAB_MODELS) {
        const applicable = !!(m.predict && m.targets.includes(nc.target));
        const pr = preds[m.id] || null;
        nowRows.push({
          modelId: m.id, target: nc.target, applicable,
          predMs: pr ? pr.predMs : null,
          deltaVsChampionMin: (pr && refMs != null && m.id !== ch) ? (pr.predMs - refMs) / 60000 : null,
          reason: applicable ? (pr ? null : 'pas encore assez d’échantillons pour ce modèle') : 'ne prédit pas cette cible',
        });
      }
    }

    const weeksSeen = weekly.map(r => r.ageWeek);
    return {
      nowMs, birthMs, state,
      ageDays: this._labAgeDays(nowMs, birthMs),
      dataStartMs: isFinite(S.startMs) ? S.startMs : null,
      models: this.LAB_MODELS, targets: this.LAB_TARGETS, championId: ch,
      cases, view, weekly, checkpoints, nowRows,
      counts: {
        models: this.LAB_MODELS.length,
        instantiated: this.LAB_MODELS.filter(m => m.predict).length,
        cases: cases.length,
        weekFrom: weeksSeen.length ? Math.min(...weeksSeen) : null,
        weekTo: weeksSeen.length ? Math.max(...weeksSeen) : null,
      },
    };
  },

  /* ---------- Export LLM-ready (§3.14) ----------
     Snapshot JSON auto-suffisant : les conventions de signe et les
     définitions voyagent DANS le fichier, pour qu'un LLM n'ait besoin
     ni de la spec ni d'une conversation antérieure.
     Privacy by default : domaine sommeil uniquement, identifiant neutre,
     âge en jours, aucune date de naissance ni nom. */
  _isoLocal(ms) {
    const d = new Date(ms), p = n => String(Math.abs(n)).padStart(2, '0');
    const off = -d.getTimezoneOffset(), sign = off < 0 ? '-' : '+';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      + `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  },
  _r1(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10) / 10; },

  labExport(lab) {
    const r = v => this._r1(v);
    const ch = lab.championId;
    const view = lab.view;
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();

    const models = lab.models.map(m => {
      const first = m.targets.map(t => (view.paired[m.id] || {})[t])
        .filter(p => p && p.firstComparableAgeDays != null).map(p => p.firstComparableAgeDays);
      const pairedN = m.targets.reduce((s, t) => s + (((view.paired[m.id] || {})[t] || {}).pairedN || 0), 0);
      return {
        id: m.id, label: m.label, version: m.version,
        status: view.status[m.id], targets: m.targets.slice(), features: m.features.slice(),
        parameters: m.parameters, note: m.note || null,
        blocked: m.blocked || null,
        firstComparableAgeDays: first.length ? Math.min(...first) : null,
        pairedN,
      };
    });

    const performance = [];
    for (const m of lab.models) {
      for (const t of m.targets) {
        const p = (view.perf[m.id] || {})[t];
        if (!p || !p.n) continue;
        performance.push({
          modelId: m.id, target: t, window: 'recent40', n: p.recentN,
          medianAbsErrorMin: r(p.medAbsMin), p80AbsErrorMin: r(p.p80AbsMin),
          medianSignedBiasMin: r(p.medSignedMin), totalN: p.n,
        });
      }
    }

    const pairwise = [];
    for (const m of lab.models) {
      if (m.id === ch) continue;
      for (const t of m.targets) {
        const p = (view.paired[m.id] || {})[t];
        if (!p || !p.pairedN) continue;
        pairwise.push({
          challengerId: m.id, championId: ch, target: t, pairedN: p.pairedN,
          medianGainMin: r(p.medianGainMin), p25GainMin: r(p.p25GainMin), p75GainMin: r(p.p75GainMin),
          challengerWins: p.wins, ties: p.ties, challengerLosses: p.losses,
          recent10MedianGainMin: r(p.recentShortMedianGainMin),
          championMedianAbsErrorMin: r(p.championMedAbsMin),
          challengerMedianAbsErrorMin: r(p.challengerMedAbsMin),
          challengerMedianSignedBiasMin: r(p.challengerMedSignedMin),
        });
      }
    }

    const weeklyEvolution = lab.weekly.map(w => ({
      ageWeek: w.ageWeek, challengerId: w.challengerId, championId: w.championId, target: w.target,
      pairedN: w.pairedN,
      championMedianAbsErrorMin: r(w.championMedAbsMin),
      challengerMedianAbsErrorMin: r(w.challengerMedAbsMin),
      medianGainMin: r(w.medianGainMin),
      challengerMedianSignedBiasMin: r(w.challengerMedSignedMin),
    }));

    const cases = lab.cases.map(c => {
      const predictions = {};
      for (const id of Object.keys(c.preds)) {
        predictions[id] = {
          predicted: this._isoLocal(c.preds[id].predMs),
          signedErrorMin: r(c.preds[id].signedErrMin),
          absErrorMin: r(c.preds[id].absErrMin),
        };
      }
      return {
        caseId: c.id, target: c.target, babyAgeDays: c.ageDays,
        localDateTime: this._isoLocal(c.anchorMs),
        features: {
          localHour: c.features.localHour,
          previousSleepDurationMin: r(c.features.prevSleepMin),
          previousWakeDurationMin: r(c.features.prevWakeMin),
          elapsedSleepMin: r(c.features.elapsedSleepMin),
          minutesSinceLastFeed: r(c.features.sinceFeedMin),
          lastFeedKind: c.features.feedKind == null ? null : c.features.feedKind,
          lastBottleMl: c.features.lastBottleMl == null ? null : c.features.lastBottleMl,
          feedsInPrevious3h: c.features.feeds3h == null ? null : c.features.feeds3h,
          feedClusterProfile: c.features.feedCluster == null ? null : c.features.feedCluster,
        },
        actual: this._isoLocal(c.realMs),
        predictions,
      };
    });

    const checkpoints = lab.checkpoints.filter(cp => cp.key !== 'now').map(cp => {
      const snap = {};
      if (cp.view) {
        for (const m of lab.models) {
          const per = {};
          for (const t of m.targets) {
            const p = (cp.view.paired[m.id] || {})[t], q = (cp.view.perf[m.id] || {})[t];
            per[t] = {
              status: cp.view.byTarget[m.id][t].status,
              n: q ? q.n : 0,
              medianAbsErrorMin: q ? r(q.medAbsMin) : null,
              pairedN: p ? p.pairedN : null,
              medianGainMin: p ? r(p.medianGainMin) : null,
            };
          }
          snap[m.id] = { status: cp.view.status[m.id], targets: per };
        }
      }
      return {
        checkpoint: cp.key, ageDays: cp.week * 7, date: this._isoLocal(cp.dateMs).slice(0, 10),
        pending: !!cp.future,
        focus: cp.focus, focusModelIds: cp.focusModels, question: cp.watch,
        modelSnapshots: snap,
        humanDecision: null,
      };
    });

    const experiments = [];
    for (const m of lab.models) {
      if (m.id === ch) continue;
      for (const t of m.targets) {
        const p = (view.paired[m.id] || {})[t];
        if (!p || !p.pairedN) continue;
        const bt = view.byTarget[m.id][t];
        experiments.push({
          experimentId: `${m.id}-v${m.version}-${t}`,
          status: bt.status, queued: bt.queued,
          exploration: p.exploration
            ? { pairedN: p.exploration.pairedN, medianGainMin: r(p.exploration.medianGainMin) }
            : { pairedN: p.pairedN, medianGainMin: r(p.medianGainMin) },
          confirmation: p.confirmation
            ? { targetN: p.confirmation.targetN, currentN: p.confirmation.currentN, medianGainMin: r(p.confirmation.medianGainMin), complete: p.confirmation.complete }
            : null,
          decision: null,
        });
      }
    }

    return {
      schemaVersion: this.LAB_SCHEMA_VERSION,
      generatedAt: this._isoLocal(lab.nowMs),
      export: {
        purpose: 'LLM analysis of champion/challenger sleep prediction models',
        privacyMode: 'sleep-and-feeding-deidentified',
        featuresIncluded: ['babyAgeDays', 'localHour', 'previousSleepDurationMin', 'previousWakeDurationMin', 'elapsedSleepMin',
          'minutesSinceLastFeed', 'lastFeedKind', 'lastBottleMl', 'feedsInPrevious3h', 'feedClusterProfile'],
      },
      context: {
        subjectId: this.LAB_SUBJECT_ID,
        ageDaysAtExport: lab.ageDays,
        dataStartDate: lab.dataStartMs != null ? this._isoLocal(lab.dataStartMs).slice(0, 10) : null,
        timezone: tz,
        championModelId: ch,
        state: lab.state,
      },
      conventions: {
        durationUnit: 'minutes',
        signedError: 'actual - predicted; positive means actual happened later',
        pairedGain: 'absError(M0) - absError(Mx); positive means challenger is better',
        maturityBadge: 'depends on n only; it is not prediction quality',
        walkForward: 'each prediction uses only data available before the case',
        remainingTarget: 'wake re-predicted at the time M0 had announced, only for episodes that outlasted it',
        promotion: 'never automatic; freezing for confirmation is mechanical, promotion is a human decision',
        feedTiming: 'feeds are point-in-time logs: no end time is recorded, so minutesSinceLastFeed counts from the logged instant. Feed duration is a tapped preset (5/10/15/20/30), never used as a feature and never converted into a volume',
        feedFeatureAnchor: 'feeding features are measured at the case anchor (the real wake for onset, the real sleep onset for wake) and are null for the remaining probe, whose anchor is mid-episode: do not pool them across targets',
        feedFeatureGaps: 'all feeding features are null when no feed is known within 12h before the anchor; lastBottleMl is null when the last feed was breastfeeding',
      },
      models,
      currentPredictions: lab.nowRows.map(row => ({
        modelId: row.modelId, target: row.target, applicable: row.applicable,
        predicted: row.predMs != null ? this._isoLocal(row.predMs) : null,
        deltaVsChampionMin: r(row.deltaVsChampionMin),
        status: view.status[row.modelId],
        reason: row.reason,
      })),
      performance,
      pairwiseComparisonsVsChampion: pairwise,
      weeklyEvolution,
      checkpoints,
      experiments,
      cases,
      analysisGuide: [
        'Compare challengers to M0 only on paired cases.',
        'Do not interpret maturity/recul as accuracy.',
        'Separate exploratory results from non-overlapping confirmation results.',
        'Inspect signed bias as well as absolute error.',
        'Look for drift over age/week and conditional effects in cases.',
        'Prefer a simpler model unless the gain is material and stable.',
        'Do not recommend promotion solely from the latest 10 cases.',
        'The more regular the feeding rhythm, the more minutesSinceLastFeed is collinear with the time-since-wake M0 already uses: judge MF models on the cases where the rhythm breaks (feed clusters, unusually long gaps), not on a global average.',
      ],
    };
  },
};

if (typeof window !== 'undefined') window.Stats = Stats;
