/* Réglages partagés : petites opérations indépendantes transportées par Store.
   Aucun événement de soin n'est renommé ni supprimé. Ordre total reproductible
   (date puis id), y compris après réception dans un ordre différent. */
const Personalization = {
  ACTION: '__ui_setting',
  text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  },
  derive(defaults, rows) {
    const initial = defaults.map(a => ({ ...a, place: a.place === 'history' ? 'tile' : a.place, hidden: a.place === 'history' }));
    const actions = new Map(initial.map(a => [a.id, { ...a }]));
    const orders = {};
    const sorted = rows.filter(r => !r.deleted && r.action === this.ACTION && Number.isFinite(Date.parse(r.ts)))
      .slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
    for (const row of sorted) {
      const { target, field, value } = row.data || {};
      if (field === 'reset' && target === '*') {
        for (const [id, a] of actions) if (a.custom) actions.set(id, { ...a, hidden: true });
        for (const a of initial) actions.set(a.id, { ...a });
        delete orders.tile; delete orders.checklist;
        continue;
      }
      if (field === 'order' && ['tile', 'checklist'].includes(target) && Array.isArray(value)) {
        orders[target] = [...new Set(value.filter(id => typeof id === 'string'))];
        continue;
      }
      if (field === 'definition' && typeof target === 'string' && /^custom_[a-zA-Z0-9-]+$/.test(target) && !actions.has(target)) {
        const name = this.text(value && value.name, 32), emoji = this.text(value && value.emoji, 16);
        if (name) actions.set(target, { id: target, name, emoji: emoji || '✓', place: 'checklist', color: 'var(--c-soins)', hidden: false, custom: true });
        continue;
      }
      const a = actions.get(target);
      if (!a) continue;
      if (field === 'hidden' && typeof value === 'boolean') a.hidden = value;
      if (field === 'name' && this.text(value, 32)) { a.name = this.text(value, 32); a.short = a.name; }
      if (field === 'emoji' && this.text(value, 16)) a.emoji = this.text(value, 16);
    }
    const list = [...actions.values()];
    const ordered = place => {
      const order = orders[place] || [];
      const rank = id => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
      return list.filter(a => a.place === place).sort((a, b) => rank(a.id) - rank(b.id));
    };
    return { all: list, tiles: ordered('tile'), checks: ordered('checklist') };
  },
};
