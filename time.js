/* Heures locales et temps écoulé : une journée civile peut durer 23 ou 25 h. */
const LocalTime = {
  candidates(day, hours, minutes) {
    const base = new Date(day), offsets = new Set();
    for (const delta of [-1, 0, 1]) {
      const d = new Date(base); d.setDate(d.getDate() + delta); d.setHours(12, 0, 0, 0);
      offsets.add(d.getTimezoneOffset());
    }
    const wall = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes);
    return [...offsets].map(offset => new Date(wall + offset * 60000))
      .filter(d => d.getFullYear() === base.getFullYear() && d.getMonth() === base.getMonth() && d.getDate() === base.getDate() && d.getHours() === hours && d.getMinutes() === minutes)
      .sort((a, b) => a - b);
  },
  offsetLabel(date) {
    const offset = -new Date(date).getTimezoneOffset();
    return `UTC${offset >= 0 ? '+' : '−'}${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 ? ':' + String(Math.abs(offset) % 60).padStart(2, '0') : ''}`;
  },
  band(day, startHour, endHour) {
    const midnight = new Date(day); midnight.setHours(0, 0, 0, 0);
    const at = h => { const d = new Date(midnight); d.setHours(h, 0, 0, 0); return (d - midnight) / 60000; };
    const ticks = [];
    for (let h = startHour; h <= endHour; h += 2) {
      const dates = h === 24 ? [new Date(new Date(midnight).setHours(24, 0, 0, 0))] : this.candidates(midnight, h, 0);
      dates.forEach((d, i) => ticks.push({ minute: (d - midnight) / 60000, label: `${h}h${dates.length > 1 ? (i === 0 ? '¹' : '²') : ''}` }));
    }
    return { start: at(startHour), end: at(endHour), noon: at(12), dayEnd: at(24), ticks, at };
  },
};
