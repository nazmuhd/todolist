/**
 * Karma: the productivity stats view.
 */
import { state } from '../core/state.js';
import { parseDate, toISODate, todayISO, daysFromToday, prevDayISO } from '../core/dates.js';
import { escapeHtml } from '../core/text.js';

export function karmaSummary(days = 14) {
  const byDay = new Map();
  state.tasks.forEach(t => {
    if (!t.completed || !t.completedAt) return;
    const key = toISODate(new Date(t.completedAt));
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });

  const today = todayISO();
  const weekStart = daysFromToday(-6);
  let week = 0;
  let total = 0;
  byDay.forEach((n, key) => {
    total += n;
    if (key >= weekStart && key <= today) week += n;
  });

  // Current streak: consecutive days with a completion, ending today (or
  // yesterday, so the streak does not break before the first task of the day).
  let streak = 0;
  let cursor = byDay.has(today) ? today : prevDayISO(today);
  while (byDay.has(cursor)) {
    streak++;
    cursor = prevDayISO(cursor);
  }

  // Best streak: the longest run of consecutive days ever.
  const sorted = [...byDay.keys()].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  sorted.forEach(key => {
    run = (previous && prevDayISO(key) === previous) ? run + 1 : 1;
    if (run > best) best = run;
    previous = key;
  });

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = daysFromToday(-i);
    series.push({
      iso,
      n: byDay.get(iso) || 0,
      label: new Intl.DateTimeFormat('en', { weekday: 'narrow' }).format(parseDate(iso)),
    });
  }

  return {
    byDay, today: byDay.get(today) || 0, week, streak, best, total,
    days: series,
    max: Math.max(1, ...series.map(d => d.n)),
  };
}

export function renderKarma() {
  const box = document.getElementById('karma-view');
  const s = karmaSummary();
  box.innerHTML = `
    <div class="karma-cards">
      <div class="karma-card"><div class="karma-num">${s.today}</div><div class="karma-label">Completed today</div></div>
      <div class="karma-card"><div class="karma-num">${s.week}</div><div class="karma-label">Last 7 days</div></div>
      <div class="karma-card"><div class="karma-num">${s.streak}</div><div class="karma-label">Day streak</div></div>
      <div class="karma-card"><div class="karma-num">${s.best}</div><div class="karma-label">Best streak</div></div>
      <div class="karma-card"><div class="karma-num">${s.total}</div><div class="karma-label">All time</div></div>
    </div>
    <div class="karma-heading">Last 14 days</div>
    <div class="karma-chart">
      ${s.days.map(d => `
        <div class="karma-col" title="${escapeHtml(d.iso)}: ${d.n} completed">
          <div class="karma-bar${d.n ? '' : ' empty'}" style="height:${Math.max(2, Math.round((d.n / s.max) * 100))}%"></div>
          <span class="karma-day">${escapeHtml(d.label)}</span>
        </div>`).join('')}
    </div>`;
}
