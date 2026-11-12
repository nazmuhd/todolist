/**
 * A deliberately small, safe Markdown renderer.
 *
 * Descriptions and comments are plain text in the data model; this module
 * turns the common formatting people type (bold, italics, code, links,
 * lists, checkboxes and fenced blocks) into HTML. Everything is escaped
 * first, so raw HTML in a task can never be injected into the page.
 */
import { escapeHtml } from './text.js';

const PLACEHOLDER = /\u0000(?:CODE|BLOCK)(\d+)\u0000/g;

function safeUrl(url) {
  return /^(https?:\/\/|mailto:|\/(?!\/))/i.test(url) ? url : null;
}

function protectCode(text, store) {
  // Fenced blocks first, then inline code spans.
  let out = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, _lang, body) => {
    store.push(`<pre class="md-pre"><code>${escapeHtml(String(body).replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${store.length - 1}\u0000`;
  });
  out = out.replace(/`([^`\n]+)`/g, (_m, body) => {
    store.push(`<code class="md-code">${escapeHtml(body)}</code>`);
    return `\u0000CODE${store.length - 1}\u0000`;
  });
  return out;
}

function formatInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeUrl(url);
    return href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : match;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return out;
}

function restore(text, store) {
  return text.replace(PLACEHOLDER, (_m, index) => store[Number(index)] || '');
}

/** One-line/inline rendering, useful for task rows. Newlines become breaks. */
export function renderMarkdownInline(text) {
  if (!text) return '';
  const store = [];
  const protectedText = protectCode(String(text), store);
  return restore(formatInline(protectedText).replace(/\n/g, '<br>'), store);
}

/** Block rendering for descriptions and comments. */
export function renderMarkdown(text) {
  if (!text) return '';
  const store = [];
  const source = protectCode(String(text), store);
  const lines = source.split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol'

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    if (/^\u0000BLOCK\d+\u0000$/.test(line.trim())) {
      closeList();
      out.push(line.trim());
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level} class="md-h">${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out.push('<hr class="md-hr">');
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote class="md-quote">${formatInline(quote[1])}</blockquote>`);
      continue;
    }

    const check = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul class="md-list md-checklist">'); }
      const checked = check[1].toLowerCase() === 'x';
      out.push(`<li class="md-check${checked ? ' is-done' : ''}"><span class="md-box" aria-hidden="true">${checked ? '✓' : ''}</span>${formatInline(check[2])}</li>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul class="md-list">'); }
      out.push(`<li>${formatInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol class="md-list">'); }
      out.push(`<li>${formatInline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p class="md-p">${formatInline(line)}</p>`);
  }

  closeList();
  return restore(out.join(''), store);
}

/** Plain text with the formatting markers removed (for previews/exports). */
export function markdownToText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '');
}
