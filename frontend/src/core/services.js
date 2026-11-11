/**
 * The app-level callback registry.
 *
 * The views (and a couple of core helpers) need things that live in the
 * entry point: opening the task dialog, opening the quick add,
 * navigating, re-rendering. Registering those callbacks here keeps the
 * imports pointing one way - app.js -> views -> core/services.js -
 * instead of the views importing the entry point back.
 */
export const services = {
  openTaskModal: () => {},
  openQuickAdd: () => {},
  navigateTo: () => {},
  openRowMenu: () => {},
  closeRowMenu: () => {},
  closeMobileSidebar: () => {},
  isMobileSidebar: () => false,
  updateModalChips: () => {},
  closeMetaMenus: () => {},
  syncHash: () => {},
  scheduleSync: () => {},
};
