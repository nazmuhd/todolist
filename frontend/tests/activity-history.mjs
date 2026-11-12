/* The activity history: a log of what happened to your tasks.
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5179, debugPort: 9315 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready');

  // Create a task (records "created").
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Activity task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Activity task')`, 'task created');
  await sleep(500);

  // Complete it (records "completed").
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Activity task'));
    if (row) row.querySelector('.task-check').click();
  })()`);
  await sleep(600);

  // Open the activity view.
  await evalJs(`document.querySelector('[data-view="activity"]').click()`);
  await sleep(600);

  check('the activity view is shown', await evalJs(`!document.getElementById('activity-view').classList.contains('hidden')`));
  const text = await evalJs(`document.getElementById('activity-view').textContent`);
  check('the creation is in the log', text.includes('Created') && text.includes('Activity task'), text.slice(0, 160));
  check('the completion is in the log', text.includes('Completed') && text.includes('Activity task'), text.slice(0, 200));

  // The log survives a reload.
  await send('Page.reload');
  await sleep(2500);
  await waitFor('window.__appReady === true', 'app ready after reload');
  await evalJs(`document.querySelector('[data-view="activity"]').click()`);
  await sleep(600);
  const after = await evalJs(`document.getElementById('activity-view').textContent`);
  check('the log survives a reload', after.includes('Activity task'), after.slice(0, 160));

  // A deleted task is still in the log.
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(300);
  await evalJs(`(() => {
    document.getElementById('quick-add-placeholder').click();
  })()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open again');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Doomed task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Doomed task')`, 'second task created');
  await sleep(400);
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Doomed task'));
    if (row) row.querySelector('.task-delete').click();
  })()`);
  await sleep(600);
  await evalJs(`document.querySelector('[data-view="activity"]').click()`);
  await sleep(600);
  const withDeleted = await evalJs(`document.getElementById('activity-view').textContent`);
  check('the deletion is in the log', withDeleted.includes('Deleted') && withDeleted.includes('Doomed task'), withDeleted.slice(0, 200));
  check('a deleted task is marked as gone', withDeleted.includes('has since been deleted'), withDeleted.slice(0, 260));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('activity run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
