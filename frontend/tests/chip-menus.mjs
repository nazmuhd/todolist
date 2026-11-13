/* The task dialog's chip menus, the shortcuts, and the bottom-bar alignment.
 *
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5173, debugPort: 9309 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload');
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(600);

  // A task to open.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Chip task';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Chip task')`, 'task created');
  await sleep(400);

  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Chip task'));
    if (row) row.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'task modal open');
  await sleep(500);

  // ---- The due chip opens a menu, not the due editor. ----
  await evalJs(`document.getElementById('meta-due').click()`);
  await sleep(400);
  check('the due chip opens a menu', await evalJs(`!document.getElementById('due-menu').classList.contains('hidden')`));
  check('the due editor stays closed', await evalJs(`!document.getElementById('due-modal').open`));
  check('the due menu offers the quick dates', await evalJs(`(() => {
    const text = document.getElementById('due-menu').textContent;
    return text.includes('Today') && text.includes('Tomorrow') && text.includes('Next week') && text.includes('No date');
  })()`));
  check('the due menu can open the full editor', await evalJs(`!!document.querySelector('#due-menu [data-chip-action="due-open"]')`));

  await evalJs(`document.querySelector('#due-menu [data-chip-action="due-set"]').click()`);
  await sleep(400);
  check('picking a date updates the chip', await evalJs(`document.getElementById('meta-due-text').textContent !== 'Due date'`),
    await evalJs(`document.getElementById('meta-due-text').textContent`));

  // ---- The priority menu. ----
  await evalJs(`document.getElementById('meta-priority').click()`);
  await sleep(400);
  check('the priority menu opens', await evalJs(`!document.getElementById('priority-menu').classList.contains('hidden')`));
  check('the priority menu lists the built-in levels', await evalJs(`(() => {
    const text = document.getElementById('priority-menu').textContent;
    return text.includes('Priority 1') && text.includes('Priority 2')
      && text.includes('Priority 3') && text.includes('Priority 4');
  })()`));
  check('the priority menu can add a priority', await evalJs(`!!document.querySelector('#priority-menu [data-chip-action="priority-new"]')`));

  // Add a custom priority.
  await evalJs(`document.querySelector('#priority-menu [data-chip-action="priority-new"]').click()`);
  await sleep(400);
  check('a name prompt appears', await evalJs(`!!document.getElementById('quick-name-prompt')`));
  await evalJs(`(() => {
    const i = document.querySelector('#quick-name-prompt input');
    i.value = 'Urgent';
    document.querySelector('#quick-name-prompt [data-prompt-ok]').click();
  })()`);
  await sleep(500);
  check('the new priority is used', (await evalJs(`document.getElementById('meta-priority-text').textContent`)) === 'Urgent',
    await evalJs(`document.getElementById('meta-priority-text').textContent`));

  // The new level shows up in the menu.
  await evalJs(`document.getElementById('meta-priority').click()`);
  await sleep(400);
  check('the custom priority is listed', await evalJs(`document.getElementById('priority-menu').textContent.includes('Urgent')`));
  await evalJs(`document.getElementById('view-title-text').click()`);
  await sleep(250);

  // ---- The project menu can add a project. ----
  await evalJs(`document.getElementById('meta-project').click()`);
  await sleep(400);
  check('the project menu opens', await evalJs(`!document.getElementById('project-menu').classList.contains('hidden')`));
  check('the project menu can add a project', await evalJs(`!!document.querySelector('#project-menu [data-chip-action="project-new"]')`));
  await evalJs(`document.querySelector('#project-menu [data-chip-action="project-new"]').click()`);
  await sleep(400);
  await evalJs(`(() => {
    const i = document.querySelector('#quick-name-prompt input');
    i.value = 'Fresh Project';
    document.querySelector('#quick-name-prompt [data-prompt-ok]').click();
  })()`);
  await sleep(500);
  check('the new project is used', (await evalJs(`document.getElementById('meta-project-text').textContent`)) === 'Fresh Project',
    await evalJs(`document.getElementById('meta-project-text').textContent`));

  // ---- The label menu can add a label. ----
  await evalJs(`document.getElementById('meta-label').click()`);
  await sleep(400);
  check('the label menu opens', await evalJs(`!document.getElementById('label-menu').classList.contains('hidden')`));
  check('the label menu can add a label', await evalJs(`!!document.querySelector('#label-menu [data-chip-action="label-new"]')`));
  await evalJs(`document.querySelector('#label-menu [data-chip-action="label-new"]').click()`);
  await sleep(400);
  await evalJs(`(() => {
    const i = document.querySelector('#quick-name-prompt input');
    i.value = 'fresh';
    document.querySelector('#quick-name-prompt [data-prompt-ok]').click();
  })()`);
  await sleep(500);
  check('the new label is used', (await evalJs(`document.getElementById('meta-label-text').textContent`)).includes('@fresh'),
    await evalJs(`document.getElementById('meta-label-text').textContent`));

  // Save and check everything stuck.
  await evalJs(`document.getElementById('modal-save').click()`);
  await sleep(900);
  const saved = JSON.parse(await evalJs(`(() => {
    const db = indexedDB.open('todoist-clone-files');
    return new Promise(res => {
      db.onsuccess = () => {
        const tx = db.result.transaction('docs','readonly');
        const g = tx.objectStore('docs').get('todoist-clone-v1');
        g.onsuccess = () => {
          const tasks = (g.result && g.result.value && g.result.value.tasks) || [];
          res(JSON.stringify(tasks.map(t => ({ title: t.title, custom: t.customPriorityId, labels: t.labels }))));
        };
      };
    });
  })()`));
  check('the task kept its custom priority', saved.some(t => t.custom), JSON.stringify(saved));
  check('the task kept its label', saved.some(t => (t.labels || []).length === 1), JSON.stringify(saved));

  // ---- The header opens the keyboard shortcuts. ----
  await evalJs(`document.getElementById('shortcuts-btn').click()`);
  await sleep(500);
  check('the header button opens the shortcuts', await evalJs(`document.getElementById('shortcuts-modal').open`));
  await evalJs(`document.getElementById('shortcuts-close').click()`);
  await sleep(300);

  // ---- Settings points at the shortcuts overlay. ----
  await evalJs(`document.getElementById('settings-btn').click()`);
  await sleep(800);
  check('Settings has Export and Import', await evalJs(`!!document.querySelector('#settings-body [data-open-export]') && !!document.querySelector('#settings-body [data-open-import]')`));
  await evalJs(`document.getElementById('settings-close').click()`);
  await sleep(300);

  // ---- The Today icon differs from the Calendar one. ----
  const todayIcon = await evalJs(`document.querySelector('[data-view="today"] [data-lucide]').getAttribute('data-lucide')`);
  const calendarIcon = await evalJs(`document.querySelector('[data-view="calendar"] [data-lucide]').getAttribute('data-lucide')`);
  check('Today has its own icon', todayIcon !== calendarIcon, `today=${todayIcon} calendar=${calendarIcon}`);

  // ---- The bottom bars line up. ----
  const align = () => evalJs(`(() => {
    const qa = document.getElementById('quick-add-bar').getBoundingClientRect();
    const aside = document.getElementById('sidebar');
    const bar = aside.classList.contains('sidebar-collapsed')
      ? document.getElementById('sidebar-rail')
      : aside.querySelector('.sidebar-footer:not(.sidebar-collapsed-only)');
    const b = bar.getBoundingClientRect();
    return JSON.stringify({ qa: Math.round(qa.top), bar: Math.round(b.top) });
  })()`);

  const expanded = JSON.parse(await align());
  check('the bottom bars line up when expanded', expanded.qa === expanded.bar, JSON.stringify(expanded));

  await evalJs(`document.getElementById('sidebar-toggle').click()`);
  await sleep(600);
  const collapsed = JSON.parse(await align());
  check('the bottom bars line up when collapsed', collapsed.qa === collapsed.bar, JSON.stringify(collapsed));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('chip menus run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
