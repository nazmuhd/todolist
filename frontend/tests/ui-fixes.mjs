/* The three fixes: the context menu survives a scroll, the template hint
 * becomes an icon when collapsed, and the collapsed rail has a settings
 * menu that opens upward.
 *
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5178, debugPort: 9314 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  // A desktop width, so the sidebar can be collapsed to the rail.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor('window.__appReady === true', 'app ready');

  // A task to right-click.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Context menu task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Context menu task')`, 'task created');
  await sleep(400);

  // ---- Bug 1: the context menu must survive a scroll. ----
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Context menu task'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  })()`);
  await waitFor(`!document.getElementById('context-menu').classList.contains('hidden')`, 'context menu open');
  check('the context menu opens', true);

  const before = await evalJs(`document.getElementById('context-menu').getBoundingClientRect().top`);
  await evalJs(`(() => {
    const list = document.getElementById('content-container');
    list.scrollTop += 40;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  })()`);
  await sleep(300);
  check('the context menu stays open after a scroll', await evalJs(`!document.getElementById('context-menu').classList.contains('hidden')`));

  // Clicking outside closes it.
  await evalJs(`document.getElementById('view-title-text').click()`);
  await sleep(250);
  check('clicking outside closes the context menu', await evalJs(`document.getElementById('context-menu').classList.contains('hidden')`));

  // ---- Bug 2: the template hint is an icon when collapsed. ----
  await evalJs(`document.getElementById('sidebar-toggle').click()`);
  await sleep(400);
  check('the sidebar is collapsed', await evalJs(`document.getElementById('sidebar').classList.contains('sidebar-collapsed')`));

  const hint = await evalJs(`(() => {
    const list = document.getElementById('templates-list');
    const text = list.querySelector('.sidebar-hide');
    const icon = list.querySelector('.sidebar-collapsed-only');
    return JSON.stringify({
      textHidden: !text || getComputedStyle(text).display === 'none',
      iconShown: !!icon && getComputedStyle(icon).display !== 'none',
      iconTag: icon ? icon.querySelector('[data-lucide]') ? 'yes' : 'no' : 'none',
    });
  })()`);
  const h2 = JSON.parse(hint);
  check('the template hint text is hidden when collapsed', h2.textHidden, hint);
  check('the template hint is an icon when collapsed', h2.iconShown && h2.iconTag === 'yes', hint);

  // ---- Bug 3: the collapsed rail has a settings menu. ----
  check('the rail settings button is shown', await evalJs(`(() => {
    const btn = document.getElementById('rail-settings-btn');
    if (!btn) return false;
    const wrap = btn.closest('.sidebar-collapsed-only');
    return !!wrap && getComputedStyle(wrap).display !== 'none';
  })()`));

  await evalJs(`document.getElementById('rail-settings-btn').click()`);
  await sleep(400);
  check('the rail menu opens', await evalJs(`!document.getElementById('rail-menu').classList.contains('hidden')`));
  check('the rail menu has rows', await evalJs(`document.querySelectorAll('#rail-menu [data-rail-action]').length >= 4`),
    await evalJs(`[...document.querySelectorAll('#rail-menu [data-rail-action]')].map(b=>b.dataset.railAction).join(',')`));

  // It opens upward: above its button.
  const pos = await evalJs(`(() => {
    const menu = document.getElementById('rail-menu').getBoundingClientRect();
    const btn = document.getElementById('rail-settings-btn').getBoundingClientRect();
    return JSON.stringify({ menuBottom: Math.round(menu.bottom), btnTop: Math.round(btn.top) });
  })()`);
  const p = JSON.parse(pos);
  check('the rail menu opens upward', p.menuBottom <= p.btnTop, pos);

  // Clicking outside closes it.
  await evalJs(`document.getElementById('view-title-text').click()`);
  await sleep(250);
  check('clicking outside closes the rail menu', await evalJs(`document.getElementById('rail-menu').classList.contains('hidden')`));

  // Opening it again and choosing Settings opens the settings dialog.
  await evalJs(`document.getElementById('rail-settings-btn').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('#rail-menu [data-rail-action="settings"]').click()`);
  await sleep(500);
  check('the Settings row opens the settings dialog', await evalJs(`document.getElementById('settings-modal').open`));
  await evalJs(`document.getElementById('settings-close').click()`);

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('fixes run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
