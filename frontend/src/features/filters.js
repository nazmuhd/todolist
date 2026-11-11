/**
 * The filter query language.
 *
 * "p1 | p2", "overdue & !#work", "7 days", "@urgent" — a query is parsed into
 * a predicate that a task is matched against.
 */
import { state } from '../core/state.js';
import { isTaskOverdue } from '../core/dates.js';


let queryCache = { text: null, fn: null };

export function tokenizeQuery(text) {
  const tokens = [];
  const src = String(text || '').replace(/\bnext\s+/gi, ' ');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('&|!()'.includes(ch)) { tokens.push({ op: ch }); i++; continue; }

    let word = '';
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') { word += src[i]; i++; }
      i++;
    } else {
      while (i < src.length && !/[\s&|!()]/.test(src[i])) { word += src[i]; i++; }
      // "7 days" / "2 weeks" are a single term.
      if (/^\d+$/.test(word)) {
        const um = /^\s*(days|day|weeks|week|months|month)/i.exec(src.slice(i));
        if (um) { word += ' ' + um[1].toLowerCase(); i += um[0].length; }
      }
    }
    if (word) tokens.push({ word });
  }
  return tokens;
}

export function queryTermPredicate(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return () => true;

  if (/^p[1-4]$/.test(w)) {
    const p = Number(w[1]);
    return t => t.priority === p;
  }
  if (w.startsWith('#')) {
    const name = w.slice(1);
    return t => {
      const proj = state.projects.find(p => p.name.toLowerCase() === name);
      const wanted = proj ? proj.id : name;
      return String(t.projectId || '').toLowerCase() === wanted.toLowerCase();
    };
  }
  if (w.startsWith('@')) {
    const name = w.slice(1);
    return t => {
      const lbl = state.labels.find(l => l.name.toLowerCase() === name);
      const wanted = lbl ? lbl.id : name;
      return (t.labels || []).some(lid => String(lid).toLowerCase() === wanted.toLowerCase());
    };
  }
  if (w === 'has:date') return t => !!t.due;
  if (w === 'no:date') return t => !t.due;
  if (w === 'has:project') return t => !!t.projectId;
  if (w === 'no:project') return t => !t.projectId;
  if (w === 'has:label') return t => (t.labels || []).length > 0;
  if (w === 'has:priority') return t => t.priority < 4;

  const range = /^(\d+)\s*(days|day|weeks|week|months|month)$/.exec(w);
  if (range) {
    const days = QUERY_RANGES[range[2]] * Number(range[1]);
    return t => !!t.due && t.due >= todayISO() && t.due <= daysFromToday(days);
  }
  if (QUERY_DATE_TERMS[w]) return QUERY_DATE_TERMS[w];
  if (QUERY_WEEKDAYS.includes(w)) {
    const target = nextWeekdayISO(w);
    return t => t.due === target;
  }
  return t => `${t.title} ${t.description || ''}`.toLowerCase().includes(w);
}

/** Parses a query into a predicate. | = or, & / spaces = and, ! = not. */
export function parseQuery(text) {
  const tokens = tokenizeQuery(text);
  let pos = 0;
  const peek = () => tokens[pos];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().op === '|') {
      pos++;
      const right = parseAnd();
      const l = left;
      left = t => l(t) || right(t);
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek() && (peek().word || peek().op === '&' || peek().op === '!')) {
      if (peek().op === '&') pos++;
      const right = parseUnary();
      const l = left;
      left = t => l(t) && right(t);
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().op === '!') {
      pos++;
      const inner = parseUnary();
      return t => !inner(t);
    }
    return parseTerm();
  }
  function parseTerm() {
    const tok = peek();
    if (!tok) return () => true;
    if (tok.op === '(') {
      pos++;
      const inner = parseOr();
      if (peek() && peek().op === ')') pos++;
      return inner;
    }
    if (tok.op === ')') { pos++; return () => true; }
    pos++;
    return queryTermPredicate(tok.word || '');
  }
  if (!tokens.length) return () => true;
  return parseOr();
}

export function queryMatcher(text) {
  const key = String(text || '');
  if (queryCache.text === key) return queryCache.fn;
  queryCache = { text: key, fn: parseQuery(key) };
  return queryCache.fn;
}
