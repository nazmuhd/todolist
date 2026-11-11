/**
 * Empty states: every view brings its own copy and artwork.
 */
import { state } from '../core/state.js';
import { $ } from '../core/app.js';

export const EMPTY_STATES = {
  inbox: { title: 'Nothing in your inbox', text: 'Tasks you add without a project land here.', icon: 'inbox' },
  today: { title: 'Nothing due today', text: 'You are all caught up for today.', icon: 'calendar-check' },
  upcoming: { title: 'Nothing coming up', text: 'Tasks with a due date will appear here.', icon: 'calendar' },
  completed: { title: 'No completed tasks yet', text: 'Finished tasks appear here, ready to restore.', icon: 'circle-check-big' },
  'no-date': { title: 'Everything has a date', text: 'No undated tasks right now.', icon: 'calendar-x' },
  'no-priority': { title: 'Every task has a priority', text: 'No P4 tasks right now.', icon: 'flag' },
  project: { title: 'No tasks in this project', text: 'Add a task to get started.', icon: 'hash' },
  label: { title: 'No tasks with this label', text: 'Tasks with this label will show up here.', icon: 'tag' },
  filter: { title: 'No matches', text: 'This filter matches nothing right now.', icon: 'filter' },
  search: { title: 'No matches', text: 'Try a different word or clear the search.', icon: 'search' },
};


export function currentEmptyState() {
  const view = state.ui.view;
  if ((state.ui.search || '').trim()) return EMPTY_STATES.search;
  if (view.startsWith('project:')) return EMPTY_STATES.project;
  if (view.startsWith('label:')) return EMPTY_STATES.label;
  if (view.startsWith('filter:')) return EMPTY_STATES.filter;
  return EMPTY_STATES[view] || { title: 'All clear', text: 'Add your first task to get started.', icon: 'clipboard-check' };
}

export function showEmptyState(title, text, showCta = true) {
  const preset = currentEmptyState();
  $('#empty-state').classList.remove('hidden');
  $('#empty-title').textContent = title || preset.title;
  $('#empty-text').textContent = text || preset.text;
  $('#empty-cta').classList.toggle('hidden', !showCta);
  const card = $('#empty-illustration-card');
  if (card) {
    card.innerHTML = `<i data-lucide="${preset.icon}" class="w-7 h-7"></i>`;
    lucide.createIcons();
  }
}
