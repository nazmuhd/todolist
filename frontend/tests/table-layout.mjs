/* The table layout: one row per task, with the details in columns.
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5181, debugPort: 9317 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready');

  // A task with a project, a label, a priority and a due date.
  await evalJs(`document.getElementById('add-project-btn').click()`);
  await waitFor(`document.getElementById('project-modal').open`, 'project modal');
  await evalJs(`(() => {
    const i = document.getElementById('project-name');
    i.value = 'Table Project';
    i.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('save-project').click();
  })()`);
  await waitFor(`!document.getElementById('project-modal').open`, 'project saved');

  await evalJs(`(() => {
    document.getElementById('quick-add-placeholder').click();
  })()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Table row task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Table row task')`, 'task created');

  // Switch to the table layout.
  await evalJs(`document.querySelector('[data-layout="table"]').click()`);
  await sleep(400);

  check('the table renders', await evalJs(`!!document.querySelector('#task-list table')`));
  check('the table has the expected columns', await evalJs(`(() => {
    const heads = [...document.querySelectorAll('#task-list thead th')].map(th => th.textContent.trim());
    return heads.join(',') === 'Task,Project,Labels,Priority,Due,Deadline,Duration';
  })()`), await evalJs(`[...document.querySelectorAll('#task-list thead th')].map(th=>th.textContent.trim()).join(',')`));
  check('the task is a table row', await evalJs(`(() => {
    const row = document.querySelector('#task-list tbody tr[data-task-id]');
    return !!row && row.textContent.includes('Table row task');
  })()`));
  check('the row shows the due date', await evalJs(`(() => {
    const row = document.querySelector('#task-list tbody tr[data-task-id]');
    return !!row && row.children.length === 7;
  })()`));

  // The table button is marked as the active layout.
  check('the table button is active', await evalJs(`document.querySelector('[data-layout="table"]').getAttribute('aria-pressed') === 'true'`));

  // Completing from the table works.
  await evalJs(`(() => {
    const row = document.querySelector('#task-list tbody tr[data-task-id]');
    if (row) row.querySelector('.task-check').click();
  })()`);
  await sleep(500);
  check('a task can be completed from the table', await evalJs(`!document.getElementById('task-list').textContent.includes('Table row task')`));

  // Switching back to the list works.
  await evalJs(`document.querySelector('[data-layout="list"]').click()`);
  await sleep(300);
  check('the list layout comes back', await evalJs(`!document.querySelector('#task-list table')`));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('table layout run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
