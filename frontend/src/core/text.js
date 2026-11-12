/**
 * Text helpers shared by every layer.
 *
 * The coercion and colour rules live here because the state normaliser
 * (core) and the HTML templates (views) need exactly the same ones -
 * and core must not import the views.
 */
export const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const PROJECT_COLORS = ['#246fe0', '#058527', '#db4c3f', '#eb8909', '#8a4dff', '#0f9d58'];
export const LABEL_COLORS = ['#db4c3f', '#eb8909', '#246fe0', '#058527', '#8a4dff'];
// The colours a custom priority level can be given.
export const PRIORITY_LEVEL_COLORS = ['#db4c3f', '#eb8909', '#246fe0', '#0f9d58', '#8a4dff', '#c2185b'];

export const asText = (v) => (typeof v === 'string' ? v : '');
export const cleanColor = (c, fallback) => (typeof c === 'string' && COLOR_RE.test(c) ? c : fallback);
export const clampPriority = (p) => (Number.isInteger(p) && p >= 1 && p <= 4 ? p : 4);

/** Escapes a value for safe interpolation into HTML. */
export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * Escapes text and wraps every occurrence of the search term in
 * <mark>, so matches stand out in the result list.
 */
export function highlightHtml(text, term) {
  const safe = escapeHtml(text);
  const needle = escapeHtml((term || '').trim());
  if (!needle) return safe;
  try {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark class="search-hit">${m}</mark>`);
  } catch {
    return safe;
  }
}
