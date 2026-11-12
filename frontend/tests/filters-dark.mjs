/* The filter dialog, the shortcuts overlay and the dark-mode fixes.
 *
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5170, debugPort: 9306 });
const { send, evalJs, waitFor, check, errors } = h;

/** Switches the app into dark mode. */
async function useDarkMode() {
  await evalJs(`(() => {
    const s = JSON.parse(localStorage.getItem('todoist-clone-settings') || '{}');
    s.theme = 'dark';
    localStorage.setItem('todoist-clone-settings', JSON.stringify(s));
    document.documentElement.dataset.theme = 'dark';
  })()`);
  await sleep(300);
}

/** Finds text that is too dark against its background. */
const lowContrast = () => evalJs(`(() => {
  const parse = c => {
    const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 20, g: 20, b: 20, a: 1 };
  };
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!text) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.3) return;
    const bg = bgOf(el);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 3) bad.push(text.slice(0, 30) + ' ' + cs.color);
  });
  return JSON.stringify(bad);
})()`);

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload');
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(600);

  // ---- The filter "+" opens a dialog, with a Cancel button. ----
  await evalJs(`document.getElementById('add-filter-btn').click()`);
  await sleep(500);
  check('the filter button opens a dialog', await evalJs(`document.getElementById('filter-modal').open`));
  check('the dialog has a Cancel button', await evalJs(`!!document.getElementById('filter-modal-cancel')`));
  check('the dialog has a Save button', await evalJs(`!!document.getElementById('filter-modal-save')`));

  // Cancel closes it without saving.
  await evalJs(`document.getElementById('filter-modal-cancel').click()`);
  await sleep(400);
  check('Cancel closes the dialog', await evalJs(`!document.getElementById('filter-modal').open`));
  check('Cancel saves nothing', await evalJs(`document.querySelectorAll('#filters-list [data-view^="filter:"]').length === 0`));

  // Saving one works.
  await evalJs(`document.getElementById('add-filter-btn').click()`);
  await sleep(400);
  await evalJs(`(() => {
    document.getElementById('filter-modal-name').value = 'My filter';
    document.getElementById('filter-modal-query').value = 'p1';
    document.getElementById('filter-modal-save').click();
  })()`);
  await sleep(700);
  check('the filter is saved', await evalJs(`document.getElementById('filters-list').textContent.includes('My filter')`));

  // Editing it reopens the dialog with its values, via the row "…" menu.
  await evalJs(`(() => {
    const btn = document.querySelector('#filters-list [data-menu-type="filter"]');
    if (btn) btn.click();
  })()`);
  await sleep(500);
  check('the filter row menu opens', await evalJs(`!document.getElementById('row-menu').classList.contains('hidden')`));
  await evalJs(`(() => {
    const item = document.querySelector('#row-menu [data-row-action="edit"]');
    if (item) item.click();
  })()`);
  await sleep(600);
  check('editing a filter opens the dialog', await evalJs(`document.getElementById('filter-modal').open`));
  check('the dialog has the filter name', (await evalJs(`document.getElementById('filter-modal-name').value`)) === 'My filter',
    await evalJs(`document.getElementById('filter-modal-name').value`));
  check('the dialog has the filter query', (await evalJs(`document.getElementById('filter-modal-query').value`)) === 'p1',
    await evalJs(`document.getElementById('filter-modal-query').value`));
  await evalJs(`document.getElementById('filter-modal-cancel').click()`);
  await sleep(300);

  // ---- The shortcuts live in their own popup. ----
  await evalJs(`document.getElementById('shortcuts-btn').click()`);
  await sleep(500);
  check('the header button opens the shortcuts popup', await evalJs(`document.getElementById('shortcuts-modal').open`));
  check('the popup is grouped', await evalJs(`document.querySelectorAll('#shortcuts-list .shortcut-group').length >= 3`),
    await evalJs(`String(document.querySelectorAll('#shortcuts-list .shortcut-group').length)`));
  check('the popup lists the shortcuts', await evalJs(`document.querySelectorAll('#shortcuts-list .shortcut-row').length > 10`));
  await evalJs(`document.getElementById('shortcuts-close').click()`);
  await sleep(300);

  // Settings points at the popup rather than listing them.
  await evalJs(`document.getElementById('settings-btn').click()`);
  await sleep(800);
  check('Settings links to the shortcuts popup', await evalJs(`!!document.querySelector('#settings-body [data-open-shortcuts]')`));
  check('Settings does not list the shortcuts itself', await evalJs(`document.querySelectorAll('#settings-body .shortcut-row').length === 0`));
  await evalJs(`document.querySelector('#settings-body [data-open-shortcuts]').click()`);
  await sleep(600);
  check('the Settings link opens the popup', await evalJs(`document.getElementById('shortcuts-modal').open`));
  await evalJs(`document.getElementById('shortcuts-close').click()`);
  await sleep(300);

  // The collapsed rail menu opens the same popup.
  await evalJs(`document.getElementById('settings-close').click()`);
  await sleep(300);
  if (!await evalJs(`document.getElementById('sidebar').classList.contains('sidebar-collapsed')`)) {
    await evalJs(`document.getElementById('sidebar-toggle').click()`);
    await sleep(600);
  }
  await evalJs(`document.getElementById('rail-settings-btn').click()`);
  await sleep(500);
  check('the rail menu opens', await evalJs(`!document.getElementById('rail-menu').classList.contains('hidden')`));
  await evalJs(`document.querySelector('#rail-menu [data-rail-action="shortcuts"]').click()`);
  await sleep(600);
  check('the rail menu opens the shortcuts popup', await evalJs(`document.getElementById('shortcuts-modal').open`));
  await evalJs(`document.getElementById('shortcuts-close').click()`);
  await sleep(300);

  // ---- The keyboard button is the last control in the header. ----
  const order = await evalJs(`(() => {
    const header = document.querySelector('.app-topbar .ml-auto');
    return [...header.children].map(c => (c.querySelector('[id]') || {}).id || c.className.slice(0, 20)).join(',');
  })()`);
  check('the keyboard button is the rightmost control', String(order).split(',').pop() === 'shortcuts-btn', String(order));

  // ---- Dark mode. ----
  await useDarkMode();
  check('the board view is readable in dark mode', JSON.parse(await lowContrast()).length === 0,
    JSON.parse(await lowContrast()).join(' | '));
  await evalJs(`document.querySelector('[data-layout="board"]').click()`);
  await sleep(600);
  check('the board has no low-contrast text', JSON.parse(await lowContrast()).length === 0,
    JSON.parse(await lowContrast()).join(' | '));
  await evalJs(`document.querySelector('[data-view="calendar"]').click()`);
  await sleep(700);
  check('the calendar has no low-contrast text', JSON.parse(await lowContrast()).length === 0,
    JSON.parse(await lowContrast()).join(' | '));
  await evalJs(`document.getElementById('shortcuts-btn').click()`);
  await sleep(500);
  check('the shortcuts popup has no low-contrast text', JSON.parse(await lowContrast()).length === 0,
    JSON.parse(await lowContrast()).join(' | '));
  await evalJs(`document.getElementById('shortcuts-close').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('settings-btn').click()`);
  await sleep(800);
  check('the settings popup has no low-contrast text', JSON.parse(await lowContrast()).length === 0,
    JSON.parse(await lowContrast()).join(' | '));
  await evalJs(`document.getElementById('settings-close').click()`);
  await sleep(300);

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('filters and shortcuts run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
