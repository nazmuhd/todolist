/**
 * Shared popover positioning.
 *
 * A leaf module: it knows about the DOM, but imports nothing, so both the
 * features (task dialog, context menu) and the UI can use it without a
 * cycle.
 */

const META_MENU_GAP = 4;
const META_MENU_MARGIN = 8;

/** Keeps a menu inside the viewport, opening upward when needed. */
export function positionContextMenu(menu, x, y) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = x;
  if (left + rect.width > vw - margin) left = vw - rect.width - margin;
  left = Math.max(margin, left);

  const spaceBelow = vh - margin - y;
  const spaceAbove = y - margin;
  let top;
  if (rect.height <= spaceBelow) top = y;
  else if (rect.height <= spaceAbove) top = y - rect.height;
  else top = Math.max(margin, Math.min(y, vh - rect.height - margin));

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(margin, top))}px`;
}

/** Positions a menu under a trigger, flipping up / clamping inside the viewport. */
export function positionBelowTrigger(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(rect.left, window.innerWidth - menuRect.width - margin);
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) top = rect.top - menuRect.height - 4;
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

export function positionMetaMenu(menu, trigger) {
  if (!menu || !trigger || menu.classList.contains('hidden')) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchor = trigger.getBoundingClientRect();

  // Measure at the origin first so clamping uses the real size.
  menu.style.position = 'fixed';
  menu.style.marginTop = '0';
  menu.style.maxHeight = 'none';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();

  const width = Math.min(rect.width, vw - META_MENU_MARGIN * 2);
  let left = anchor.left;
  if (left + width > vw - META_MENU_MARGIN) left = vw - META_MENU_MARGIN - width;
  left = Math.max(META_MENU_MARGIN, left);

  const spaceBelow = vh - META_MENU_MARGIN - (anchor.bottom + META_MENU_GAP);
  const spaceAbove = anchor.top - META_MENU_GAP - META_MENU_MARGIN;

  let top;
  let maxHeight;
  if (rect.height <= spaceBelow) {
    top = anchor.bottom + META_MENU_GAP;
    maxHeight = spaceBelow;
  } else if (rect.height <= spaceAbove) {
    top = anchor.top - META_MENU_GAP - rect.height;
    maxHeight = spaceAbove;
  } else if (spaceBelow >= spaceAbove) {
    top = anchor.bottom + META_MENU_GAP;
    maxHeight = spaceBelow;
  } else {
    top = META_MENU_MARGIN;
    maxHeight = spaceAbove;
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.maxHeight = `${Math.max(1, Math.floor(maxHeight))}px`;
  menu.style.overflowY = 'auto';
  menu.style.overscrollBehavior = 'contain';
}
