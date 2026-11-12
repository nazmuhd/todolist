/**
 * The collapsed-rail menu.
 *
 * When the sidebar is collapsed it is only an icon wide, so the footer
 * (Export, Import, Settings) is hidden. This menu takes its place: the
 * settings button in the rail opens a panel that opens upward, holding the
 * actions the narrow rail cannot show.
 *
 * The look follows the reference design: a dark panel, sections divided by
 * a hairline, an icon and a label per row, and the panel anchored above
 * the button that opened it.
 */
import { $ } from '../core/app.js';
import { escapeHtml } from '../core/text.js';
import { services } from '../core/services.js';

const railMenu = $('#rail-menu');
const railButton = $('#rail-settings-btn');

/** The rows of the menu, in the order they are shown. */
const SECTIONS = [
  {
    title: 'Data',
    items: [
      { id: 'export', icon: 'download', label: 'Export' },
      { id: 'import', icon: 'upload', label: 'Import' },
    ],
  },
  {
    title: 'Help',
    items: [
      { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard shortcuts', badge: '?' },
    ],
  },
  {
    title: 'App',
    items: [
      { id: 'settings', icon: 'settings', label: 'Settings' },
      { id: 'expand', icon: 'panel-left-open', label: 'Expand sidebar' },
    ],
  },
];

export function isRailMenuOpen() {
  return !railMenu.classList.contains('hidden');
}

export function closeRailMenu() {
  railMenu.classList.add('hidden');
  railMenu.innerHTML = '';
  if (railButton) railButton.setAttribute('aria-expanded', 'false');
}

function renderRailMenu() {
  railMenu.innerHTML = SECTIONS.map(section => `
    <div class="rail-menu-section">
      ${section.items.map(item => `
        <button type="button" class="rail-menu-item" data-rail-action="${escapeHtml(item.id)}">
          <i data-lucide="${escapeHtml(item.icon)}" class="w-4 h-4 rail-menu-icon"></i>
          <span class="flex-1 text-left">${escapeHtml(item.label)}</span>
          ${item.badge ? `<span class="rail-menu-badge">${escapeHtml(item.badge)}</span>` : ''}
        </button>`).join('')}
    </div>`).join('');
}

/** Places the panel above the button, inside the window. */
function positionRailMenu() {
  const margin = 8;
  const anchor = railButton.getBoundingClientRect();
  const rect = railMenu.getBoundingClientRect();
  const vw = window.innerWidth;

  let left = anchor.left - 8;
  if (left + rect.width > vw - margin) left = vw - rect.width - margin;
  left = Math.max(margin, left);

  // The panel opens upward, the way the reference does.
  let top = anchor.top - rect.height - 8;
  if (top < margin) top = Math.min(anchor.bottom + 8, window.innerHeight - rect.height - margin);

  railMenu.style.left = `${Math.round(left)}px`;
  railMenu.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function openRailMenu() {
  if (isRailMenuOpen()) {
    closeRailMenu();
    return;
  }
  renderRailMenu();
  railMenu.classList.remove('hidden');
  // The panel has to be measured before it can be placed.
  positionRailMenu();
  lucide.createIcons();
  if (railButton) railButton.setAttribute('aria-expanded', 'true');
}

/** Opens one of the menu's actions. */
function runRailAction(id) {
  closeRailMenu();

  if (id === 'export') {
    document.getElementById('export-data-btn')?.click();
    return;
  }
  if (id === 'import') {
    document.getElementById('import-data-btn')?.click();
    return;
  }
  if (id === 'settings') {
    document.getElementById('settings-btn')?.click();
    return;
  }
  if (id === 'shortcuts') {
    // The rail menu opens the same overlay the header button does.
    document.getElementById('shortcuts-btn')?.click();
    return;
  }
  if (id === 'expand') {
    services.setSidebarCollapsed(false);
  }
}

export function initRailMenu() {
  if (!railMenu || !railButton) return;

  railButton.onclick = (e) => {
    e.stopPropagation();
    openRailMenu();
  };

  railMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rail-action]');
    if (!btn) return;
    e.stopPropagation();
    runRailAction(btn.dataset.railAction);
  });

  // Clicking anywhere else closes it.
  document.addEventListener('click', (e) => {
    if (!isRailMenuOpen()) return;
    if (railMenu.contains(e.target) || railButton.contains(e.target)) return;
    closeRailMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isRailMenuOpen()) {
      e.preventDefault();
      closeRailMenu();
    }
  });

  window.addEventListener('resize', closeRailMenu);
  window.addEventListener('scroll', closeRailMenu, true);
}
