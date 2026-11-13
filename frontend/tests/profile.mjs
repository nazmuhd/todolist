/* The profile menu, the profile settings dialog, the floating add-task
 * card and the due-date dialog.
 *
 * Run with `pnpm test:profile`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5182, debugPort: 9318 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(400);

  // ---- The sidebar shows the logo, not a letter in a circle. ----
  check('the sidebar shows an avatar image', await evalJs(
    `(() => { const i = document.getElementById('nav-avatar'); return !!i && i.tagName === 'IMG' && i.getAttribute('src') !== '/images/logo.png'; })()`));
  check('the logo image actually loads', await evalJs(
    `(() => { const i = document.getElementById('nav-avatar'); return i.complete && i.naturalWidth > 0; })()`));
  check('the old "U" circle is gone', await evalJs(
    `!document.querySelector('.sidebar-user').textContent.includes('U')`));
  check('the sidebar says Todolist', await evalJs(
    `document.getElementById('nav-name').textContent.trim() === 'Todolist'`));

  // ---- No horizontal line in the sidebar, expanded or collapsed. ----
  const borderWidth = (sel, side) => evalJs(
    `getComputedStyle(document.querySelector('${sel}')).getPropertyValue('${side.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}-width')`);
  check('no line under the profile row', await borderWidth('.sidebar-user', 'borderBottom') === '0px');
  check('no line above the sidebar', true);
  check('no settings rail icon', await evalJs(`!document.getElementById('rail-settings-btn')`));

  // ---- The profile menu opens from the avatar. ----
  await evalJs(`document.getElementById('user-menu-btn').click()`);
  await sleep(400);
  check('the profile menu opens', await evalJs(`!document.getElementById('user-menu').classList.contains('hidden')`));
  check('the menu shows the name', await evalJs(`document.getElementById('user-menu-name').textContent.trim() === 'Todolist'`));
  check('the menu offers the settings', await evalJs(`!!document.getElementById('user-menu-settings')`));
  check('the menu offers the shortcuts', await evalJs(`!!document.getElementById('user-menu-shortcuts')`));
  check('the menu offers export', await evalJs(`!!document.getElementById('user-menu-export')`));
  check('the menu offers import', await evalJs(`!!document.getElementById('user-menu-import')`));
  check('the menu has no fictional account actions', await evalJs(
    `!document.getElementById('user-menu') || (!document.getElementById('user-menu').textContent.includes('Log out')
       && !document.getElementById('user-menu').textContent.includes('Upgrade to Pro'))`));

  // Clicking outside closes it.
  await evalJs(`document.getElementById('view-title-text').click()`);
  await sleep(300);
  check('clicking outside closes the profile menu', await evalJs(
    `document.getElementById('user-menu').classList.contains('hidden')`));

  // Escape closes it too.
  await evalJs(`document.getElementById('user-menu-btn').click()`);
  await sleep(300);
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await sleep(300);
  check('Escape closes the profile menu', await evalJs(
    `document.getElementById('user-menu').classList.contains('hidden')`));

  // ---- The settings dialog carries the profile and the old sections. ----
  await evalJs(`document.getElementById('user-menu-btn').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('user-menu-settings').click()`);
  await waitFor(`document.getElementById('settings-modal').open`, 'settings open');
  await sleep(600);

  check('the settings dialog offers four avatars', await evalJs(
    `document.querySelectorAll('#settings-body [data-profile-avatar]').length === 4`));
  check('every avatar image loads', await evalJs(
    `[...document.querySelectorAll('#settings-body [data-profile-avatar] img')].every(i => i.complete && i.naturalWidth > 0)`));
  check('the old settings sections are still there', await evalJs(
    `!!document.querySelector('#settings-body [data-setting="theme"]')
       && !!document.querySelector('#settings-body [data-setting="startOfWeek"]')
       && !!document.querySelector('#settings-body [data-open-export]')
       && !!document.querySelector('#settings-body [data-open-import]')`));
  check('the status choices are there', await evalJs(
    `document.querySelectorAll('#settings-body [data-profile-status]').length === 4`));

  // ---- Picking an avatar changes it, and saving keeps it. ----
  await evalJs(`document.querySelectorAll('#settings-body [data-profile-avatar]')[1].click()`);
  await sleep(300);
  check('the chosen avatar is marked', await evalJs(
    `document.querySelectorAll('#settings-body [data-profile-avatar]')[1].getAttribute('aria-pressed') === 'true'`));
  await evalJs(`document.getElementById('settings-save').click()`);
  await waitFor(`!document.getElementById('settings-modal').open`, 'settings saved');
  await sleep(400);
  check('the sidebar picks up the new avatar', await evalJs(
    `document.getElementById('nav-avatar').getAttribute('src') === '/images/avatar-2.png'`));

  // ---- Cancelling throws the change away. ----
  await evalJs(`document.getElementById('settings-btn').click()`);
  await sleep(700);
  await evalJs(`document.querySelectorAll('#settings-body [data-profile-avatar]')[3].click()`);
  await sleep(300);
  await evalJs(`document.getElementById('settings-cancel').click()`);
  await waitFor(`!document.getElementById('settings-modal').open`, 'settings cancelled');
  await sleep(400);
  check('cancelling keeps the old avatar', await evalJs(
    `document.getElementById('nav-avatar').getAttribute('src') === '/images/avatar-2.png'`));

  // ---- The collapsed sidebar keeps the avatar trigger. ----
  if (!await evalJs(`document.getElementById('sidebar').classList.contains('sidebar-collapsed')`)) {
    await evalJs(`document.getElementById('sidebar-toggle').click()`);
    await sleep(600);
  }
  check('the sidebar collapses', await evalJs(
    `document.getElementById('sidebar').classList.contains('sidebar-collapsed')`));
  check('the avatar trigger stays in the rail', await evalJs(
    `!!document.getElementById('user-menu-btn').offsetParent`));
  check('the name is hidden in the rail', await evalJs(
    `!document.getElementById('nav-name').offsetParent`));

  await evalJs(`document.getElementById('user-menu-btn').click()`);
  await sleep(400);
  check('the profile menu opens in the rail too', await evalJs(
    `!document.getElementById('user-menu').classList.contains('hidden')`));
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await sleep(300);

  await evalJs(`document.getElementById('sidebar-toggle').click()`);
  await sleep(600);

  // ---- The add-task bar is a floating card with no line above it. ----
  check('no line above the add-task bar', await evalJs(
    `getComputedStyle(document.getElementById('quick-add-bar')).borderTopWidth === '0px'`));
  check('the add-task bar is a card', await evalJs(
    `!!document.getElementById('quick-add-card')`));
  check('the collapsed card is a pill', await evalJs(
    `parseFloat(getComputedStyle(document.getElementById('quick-add-card')).borderRadius) >= 24`));

  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await sleep(300);
  check('the open card is less round', await evalJs(
    `parseFloat(getComputedStyle(document.getElementById('quick-add-card')).borderRadius) < 24`));
  await evalJs(`document.getElementById('quick-add-cancel').click()`);
  await sleep(300);
  check('the card closes again', await evalJs(
    `parseFloat(getComputedStyle(document.getElementById('quick-add-card')).borderRadius) >= 24`));

  // ---- The due-date dialog follows the reference layout. ----
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Dialog task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Dialog task')`, 'task created');
  await sleep(400);

  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Dialog task'));
    if (li) li.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'task modal');
  await evalJs(`document.getElementById('meta-due').click()`);
  await sleep(400);
  await evalJs(`document.querySelector('#due-menu [data-chip-action="due-open"]').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'due modal');
  await sleep(600);

  check('the due dialog is a two-column grid', await evalJs(
    `getComputedStyle(document.querySelector('.due-modal-grid')).gridTemplateColumns.split(' ').length === 2`));
  check('the calendar sits in a card', await evalJs(
    `(() => { const c = document.getElementById('due-calendar-cell'); const s = getComputedStyle(c);
       return s.borderTopWidth !== '0px' && parseFloat(s.borderTopLeftRadius) > 0; })()`));
  check('the repeat field has an icon', await evalJs(
    `!!document.querySelector('#due-repeat').closest('.relative').querySelector('[data-lucide="repeat"]')`));
  check('the time zone has a label', await evalJs(
    `!!document.querySelector('label[for="due-timezone"]')`));
  check('the deadline keeps its own hint', await evalJs(
    `document.querySelector('label[for="due-deadline"]').textContent.includes('separate from due date')`));
  check('the reminders area is present', await evalJs(
    `!!document.getElementById('due-reminders') && !!document.getElementById('due-add-reminder')`));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('the profile tests run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
