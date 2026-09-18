/* Comparaison simplifiée : M6 (endormissement), M3 (réveil), H1 concurrent.
   Les anciennes expériences de stats.js restent disponibles pour audit seulement.
   Paramètres H1 fixés avant comparaison ; aucun réglage automatique sur l'export. */
const SleepModels = {
  version: '1.0',
  parameters: { days: 28, maxSamples: 160, halfLifeDays: 7, hourBandwidth: 3, shrinkage: 8, minSurvivors: 3 },
  hour(ms) { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; },
  start(s, target) { return target === 'onset' ? s.fromMs : s.ep.startMs; },
  quantile(points, p) {
    const sorted = points.slice().sort((a, b) => a.v - b.v);
    const total = sorted.reduce((a, b) => a + b.w, 0);
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) {
      sum += sorted[i].w;
      if (sum > total * p) return sorted[i].v;
      if (sum === total * p) return (sorted[i].v + (sorted[i + 1] || sorted[i]).v) / 2;
    }
    return null;
  },
  predict(S, target, anchorMs, asOfMs, model) {
    const elapsed = Math.max(0, (asOfMs - anchorMs) / 60000);
    const pool = target === 'onset' ? S.gaps : S.durations;
    const p = this.parameters;
    const base = Stats._predWindow(pool, asOfMs, model === 'H1' ? p.days : 14, model === 'H1' ? p.maxSamples : 40);
    if (base.length < 5) return null;
    const hour = this.hour(anchorMs);
    const night = h => h >= 20 || h < 7;
    let points, fallback = false;
    if (model !== 'H1') {
      const group = base.filter(s => target === 'onset'
        ? night(this.hour(this.start(s, target))) === night(hour)
        : Math.floor(this.hour(this.start(s, target)) / 6) === Math.floor(hour / 6));
      fallback = group.length < 5;
      points = (fallback ? base : group).map(s => ({ v: s.min, w: 1 }));
    } else {
      // Mélange progressif : proximité horaire circulaire + référence jour/nuit.
      const rows = base.map(s => {
        const h = this.hour(this.start(s, target));
        const delta = Math.abs(h - hour), distance = Math.min(delta, 24 - delta);
        const recency = Math.pow(2, -(asOfMs - s.atMs) / (p.halfLifeDays * 86400000));
        return { v: s.min, local: recency * Math.exp(-0.5 * (distance / p.hourBandwidth) ** 2),
          prior: recency * (night(h) === night(hour) ? 1 : 0.15) };
      });
      const sum = rows.reduce((a, r) => a + r.local, 0);
      const squares = rows.reduce((a, r) => a + r.local ** 2, 0);
      const effectiveN = squares ? sum * sum / squares : 0;
      const alpha = effectiveN / (effectiveN + p.shrinkage);
      const priorSum = rows.reduce((a, r) => a + r.prior, 0);
      points = rows.map(r => ({ v: r.v, w: alpha * r.local / sum + (1 - alpha) * r.prior / priorSum }));
    }
    // Même information pour les deux concurrents : bébé n'a pas encore changé d'état.
    const survivors = elapsed > 0 ? points.filter(r => r.v > elapsed) : points;
    if (survivors.length < p.minSurvivors) return null;
    const total = survivors.reduce((a, r) => a + r.w, 0);
    const effectiveN = total ** 2 / survivors.reduce((a, r) => a + r.w ** 2, 0);
    if (effectiveN < 2.5) return null;
    const median = this.quantile(survivors, .5);
    return { model, target, atMs: anchorMs + median * 60000, remainingMin: median - elapsed,
      loMs: survivors.length >= 8 && effectiveN >= 5 ? anchorMs + this.quantile(survivors, .25) * 60000 : null,
      hiMs: survivors.length >= 8 && effectiveN >= 5 ? anchorMs + this.quantile(survivors, .75) * 60000 : null,
      n: survivors.length, effectiveN, fallback, elapsedMin: elapsed };
  },
  samples(events, options) {
    const nowMs = new Date(options.now ?? new Date()).getTime();
    const known = events.filter(e => e && !e.deleted && new Date(e.ts).getTime() <= nowMs).map(e =>
      e.action === 'sommeil' && e.data && new Date(e.data.end).getTime() > nowMs
        ? { ...e, data: { ...e.data, end: null } } : e);
    return Stats._predSamples(known, { nowMs, domainStart: options.domainStart });
  },
  current(events, options = {}) {
    const nowMs = new Date(options.now || new Date()).getTime(), S = this.samples(events, options);
    const last = S.closed[S.closed.length - 1];
    const target = S.ongoing ? 'wake' : 'onset';
    const anchorMs = S.ongoing ? S.ongoing.startMs : last ? last.endMs : null;
    const reference = target === 'onset' ? 'M6' : 'M3';
    return { nowMs, target, anchorMs, state: S.ongoing ? 'ASLEEP' : last ? 'AWAKE' : 'UNKNOWN', reference,
      active: anchorMs == null ? null : this.predict(S, target, anchorMs, nowMs, reference),
      challenger: anchorMs == null ? null : this.predict(S, target, anchorMs, nowMs, 'H1') };
  },
  evaluate(events, options = {}) {
    const S = this.samples(events, options), cases = [];
    // Sondes fixées à l'avance, indépendantes des prévisions des modèles.
    for (const target of ['onset', 'wake']) {
      const pool = target === 'onset' ? S.gaps : S.durations;
      const reference = target === 'onset' ? 'M6' : 'M3';
      for (const s of pool) {
        const anchorMs = this.start(s, target);
        for (const elapsed of [0, 30, 60, 120]) {
          if (s.min <= elapsed) continue;
          const asOfMs = anchorMs + elapsed * 60000;
          const active = this.predict(S, target, anchorMs, asOfMs, reference);
          const challenger = this.predict(S, target, anchorMs, asOfMs, 'H1');
          cases.push({ target, elapsed, anchorMs, asOfMs, realMs: s.atMs, reference, active, challenger });
        }
      }
    }
    const summaries = [];
    for (const target of ['onset', 'wake']) for (const elapsed of [0, 30, 60, 120]) {
      const all = cases.filter(c => c.target === target && c.elapsed === elapsed).sort((a,b) => a.realMs-b.realMs);
      const recent = all.slice(-40); // même fenêtre de cas, y compris les abstentions
      const paired = recent.filter(c => c.active && c.challenger);
      const error = (c, key) => (c.realMs - c[key].atMs) / 60000;
      const metrics = key => {
        const abs = paired.map(c => Math.abs(error(c, key)));
        const ranged = paired.filter(c => c[key].loMs != null);
        return { median: Stats._median(abs), p80: Stats._quantile(abs, .8), bias: Stats._median(paired.map(c=>error(c,key))),
          intervalN: ranged.length, coverage: ranged.length ? ranged.filter(c => c.realMs >= c[key].loMs && c.realMs <= c[key].hiMs).length / ranged.length : null };
      };
      summaries.push({ target, elapsed, totalN: all.length, recentN: recent.length, pairedN: paired.length,
        activeN: recent.filter(c=>c.active).length, challengerN: recent.filter(c=>c.challenger).length,
        active: metrics('active'), challenger: metrics('challenger'),
        medianGain: Stats._median(paired.map(c=>Math.abs(error(c,'active'))-Math.abs(error(c,'challenger')))) });
    }
    return { schema: 'sleep-comparison/1.0', parameters: this.parameters, references: { onset: 'M6', wake: 'M3' }, challenger: 'H1',
      note: 'Reconstitution rétrospective depuis le journal courant. Paramètres exploratoires ; confirmation future nécessaire. Plages P25/P75 historiques, non calibrées. Une ligne par cible et sonde : ne pas additionner les sondes d’un même épisode.',
      nowMs: new Date(options.now || new Date()).getTime(), summaries, cases };
  },
};
