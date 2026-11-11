/**
 * The render hook.
 *
 * Core modules (tasks, undo) need to ask for a repaint, but they must not
 * import the views: the views import the core, so a direct import would be a
 * cycle. Instead the entry point registers the real renderer once.
 */
let renderer = () => {};

export function setRenderer(fn) {
  renderer = typeof fn === 'function' ? fn : () => {};
}

export function requestRender() {
  renderer();
}
