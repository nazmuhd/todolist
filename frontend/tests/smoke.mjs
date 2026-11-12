/* Frontend smoke test: boots the built app and drives the main flows.
 * Run with `pnpm test:smoke` (builds first). Uses a real headless browser. */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5199, debugPort: 9333 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload');
  await sleep(300);
  await waitFor('window.__appReady === true', 'app ready');
  check('boots', true);

  // Create a project.
  await evalJs(`document.getElementById('add-project-btn').click()`);
  await waitFor(`document.getElementById('project-modal').open`, 'project modal');
  await evalJs(`(() => {
    const i = document.getElementById('project-name');
    i.value = 'Work'; i.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('save-project').click();
  })()`);
  await waitFor(`!document.getElementById('project-modal').open`, 'project saved');
  check('create project', await evalJs(`[...document.querySelectorAll('#projects-list *')].some(e => e.textContent.includes('Work'))`));

  // Create a label.
  await evalJs(`document.getElementById('add-label-btn').click()`);
  await waitFor(`document.getElementById('label-modal').open`, 'label modal');
  await evalJs(`(() => {
    const i = document.getElementById('label-name');
    i.value = 'urgent'; i.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('save-label').click();
  })()`);
  await waitFor(`!document.getElementById('label-modal').open`, 'label saved');
  check('create label', await evalJs(`[...document.querySelectorAll('#labels-list *')].some(e => e.textContent.includes('urgent'))`));

  // Row menu (project "…"): pin the project.
  await evalJs(`document.querySelector('#projects-list .row-menu-btn').click()`);
  await waitFor(`!document.getElementById('row-menu').classList.contains('hidden')`, 'row menu');
  check('row menu opens', await evalJs(`!!document.querySelector('#row-menu [data-row-action="pin"]')`));
  await evalJs(`document.querySelector('#row-menu [data-row-action="pin"]').click()`);
  await waitFor(`document.getElementById('row-menu').classList.contains('hidden')`, 'row menu closed');
  check('row menu pin action', await evalJs(`!!document.querySelector('#projects-list [data-lucide="star"]')`));

  // Quick add.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Write report tomorrow p1 #Work @urgent';
    t.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitFor(`document.getElementById('quick-add-preview').textContent.includes('P1')`, 'quick add preview');
  const previewText = await evalJs(`document.getElementById('quick-add-preview').textContent`);
  check('quick add parses p1/date/project/label',
    await evalJs(`(() => {
      const t = document.getElementById('quick-add-preview').textContent;
      return t.includes('P1') && t.includes('Work') && t.includes('urgent') && t.includes('Tomorrow');
    })()`), previewText);
  await evalJs(`document.getElementById('quick-add-submit').click()`);
  await evalJs(`document.querySelector('#projects-list .nav-item').click()`);
  await sleep(300);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length === 1`, 'task added');
  check('quick add creates task', await evalJs(`document.getElementById('task-list').textContent.includes('Write report')`));

  // Open the task modal.
  await evalJs(`document.querySelector('#task-list .task-edit').click()`);
  await waitFor(`document.getElementById('task-modal').open`, 'task modal');
  check('task modal opens', true);
  check('task modal shows project/label/priority', await evalJs(`(() => {
    const text = document.getElementById('meta-project-text').textContent;
    return document.getElementById('meta-priority-text').textContent.includes('Priority 1')
      && text.includes('Work')
      && document.getElementById('meta-label-text').textContent.includes('urgent');
  })()`));

  // Due editor: natural language.
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'due modal');
  await evalJs(`(() => {
    const i = document.getElementById('due-nl');
    i.value = 'next Friday';
    i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  })()`);
  await waitFor(`document.getElementById('due-nl-status').textContent.includes('Due')`, 'natural due parsed');
  check('due editor natural language', true);
  const dueLabel = await evalJs(`document.getElementById('due-nl-status').textContent`);
  await evalJs(`document.getElementById('due-done').click()`);
  await waitFor(`!document.getElementById('due-modal').open`, 'due modal closed');
  check('due chip updated', await evalJs(`document.getElementById('meta-due-text').textContent !== 'Due date'`), dueLabel);

  // Save the modal.
  await evalJs(`(() => {
    const i = document.getElementById('modal-title');
    i.value = 'Write quarterly report';
    i.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('modal-save').click();
  })()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'task saved');
  check('task modal saves title', await evalJs(`document.getElementById('task-list').textContent.includes('Write quarterly report')`));

  // Context menu: set priority 2.
  await evalJs(`document.querySelector('#task-list li[data-task-id]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:120, clientY:160}))`);
  await waitFor(`!document.getElementById('context-menu').classList.contains('hidden')`, 'context menu');
  check('context menu opens with actions', await evalJs(`document.querySelectorAll('#context-menu [data-context-action]').length > 5`));
  await evalJs(`document.querySelector('#context-menu [data-context-action="priority-2"]').click()`);
  check('context menu action closes menu', await evalJs(`document.getElementById('context-menu').classList.contains('hidden')`));

  // Complete and undo through the toast.
  await evalJs(`document.querySelector('#task-list li[data-task-id] .task-check').click()`);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length === 0`, 'task completed');
  const toast = await evalJs(`document.getElementById('toast-container').textContent`);
  check('completion shows undo toast', toast.includes('Task completed'), toast.trim());
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('#toast-container button')].find(b => b.textContent.includes('Undo'));
    if (btn) btn.click();
  })()`);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length === 1`, 'undo restores task');
  check('undo restores task', true);

  // Views.
  for (const view of ['today', 'upcoming', 'calendar', 'completed', 'inbox']) {
    await evalJs(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
    await sleep(150);
  }
  check('navigation across views', await evalJs(`document.getElementById('view-title-text').textContent === 'Inbox'`));

  // Back to the project, where the task lives.
  await evalJs(`document.querySelector('#projects-list .nav-item').click()`);
  await sleep(150);

  // Board layout.
  await evalJs(`document.querySelector('#view-layout [data-layout="board"]').click()`);
  await waitFor(`!document.getElementById('board-view').classList.contains('hidden')`, 'board view');
  check('board layout renders', await evalJs(`document.getElementById('board-view').textContent.includes('Write quarterly report')`));
  await evalJs(`document.querySelector('#view-layout [data-layout="list"]').click()`);
  await waitFor(`document.getElementById('board-view').classList.contains('hidden')`, 'list view');

  // Settings.
  await evalJs(`document.getElementById('settings-btn').click()`);
  await waitFor(`document.getElementById('settings-modal').open`, 'settings modal');
  check('push settings render', await evalJs(`!!document.querySelector('#settings-body [data-push-toggle]')`));
  await evalJs(`document.querySelector('#settings-body [data-setting="theme"][data-value="dark"]').click()`);
  check('settings apply theme', await evalJs(`document.documentElement.dataset.theme === 'dark'`));
  await evalJs(`document.getElementById('settings-close').click()`);
  await waitFor(`!document.getElementById('settings-modal').open`, 'settings closed');

  // Shortcuts overlay via "?".
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'?', bubbles:true}))`);
  await waitFor(`document.getElementById('shortcuts-modal').open`, 'shortcuts modal');
  check('shortcut overlay opens', true);
  await evalJs(`document.getElementById('shortcuts-close').click()`);

  // Export dialog.
  await evalJs(`document.getElementById('export-data-btn').click()`);
  await waitFor(`document.getElementById('export-modal').open`, 'export modal');
  check('export options render', await evalJs(`document.querySelectorAll('#export-options [data-export]').length === 4`));
  await evalJs(`document.getElementById('export-close').click()`);

  // Sidebar collapse.
  const before = await evalJs(`document.getElementById('sidebar').className`);
  await evalJs(`document.getElementById('sidebar-toggle').click()`);
  await sleep(200);
  const after = await evalJs(`document.getElementById('sidebar').className`);
  check('sidebar collapses', before !== after, after);

  // Escape closes the quick add.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add reopen');
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await waitFor(`document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add closed by Escape');
  check('Escape closes quick add', true);

  // ---- Section 1: completion repetition, deadlines, timezone, reminders,
  // templates and task permalinks. ----
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add for repeat');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Daily standup every! 2 days';
    t.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await sleep(120);
  await evalJs(`document.getElementById('quick-add-submit').click()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Daily standup')`, 'repeat task added');
  check('quick add understands every!', await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    return !!li && !!li.querySelector('[data-lucide="refresh-cw"]');
  })()`));

  const dailyId = await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    return li ? li.dataset.taskId : null;
  })()`);

  // Permalink: #/task/<id> opens the dialog and closing restores the view.
  await evalJs(`location.hash = '#/task/${dailyId}'`);
  await waitFor(`document.getElementById('task-modal').open`, 'permalink opens task');
  check('task permalink opens the right task', await evalJs(`document.getElementById('modal-title').value === 'Daily standup'`));
  await evalJs(`document.getElementById('task-modal').close()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'permalink modal closed');
  await waitFor(`!location.hash.startsWith('#/task/')`, 'permalink closes back to the view');
  check('closing a permalink restores the view hash', await evalJs(`!location.hash.startsWith('#/task/')`));

  // Deadline + timezone + an absolute reminder, saved through the due editor.
  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    li.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'repeat task modal');
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'repeat due modal');
  await evalJs(`(() => {
    const d = document.getElementById('due-deadline');
    d.value = '2026-12-31';
    d.dispatchEvent(new Event('change', {bubbles:true}));
    const z = document.getElementById('due-timezone');
    z.value = 'Asia/Tokyo';
    z.dispatchEvent(new Event('change', {bubbles:true}));
    document.getElementById('due-add-reminder').click();
  })()`);
  await waitFor(`!!document.querySelector('#due-reminders [data-reminder-kind]')`, 'reminder row added');
  await evalJs(`(() => {
    const kind = document.querySelector('#due-reminders [data-reminder-kind]');
    kind.value = 'absolute';
    kind.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await waitFor(`!!document.querySelector('#due-reminders [data-reminder-at]')`, 'absolute reminder input');
  check('absolute reminder uses a datetime input', await evalJs(`document.querySelector('#due-reminders [data-reminder-at]').type === 'datetime-local'`));
  await evalJs(`document.getElementById('due-done').click()`);
  await waitFor(`!document.getElementById('due-modal').open`, 'repeat due modal closed');
  await evalJs(`document.getElementById('modal-save').click()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'repeat task saved');
  check('deadline and reminder badges render', await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    return !!li && !!li.querySelector('[data-lucide="octagon-alert"]') && !!li.querySelector('[data-lucide="bell"]');
  })()`));

  // Save the task as a reusable template and apply it.
  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    li.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'template source modal');
  await evalJs(`document.getElementById('modal-save-template').click()`);
  await evalJs(`document.getElementById('task-modal').close()`);
  await waitFor(`document.getElementById('templates-list').textContent.includes('Daily standup')`, 'template saved');
  check('task template appears in the sidebar', true);
  const beforeTemplate = await evalJs(`document.querySelectorAll('#task-list li[data-task-id]').length`);
  await evalJs(`document.querySelector('#templates-list [data-template-apply]').click()`);
  await waitFor(`document.querySelectorAll('#task-list li[data-task-id]').length > ${beforeTemplate}`, 'template applied');
  check('applying a template creates a task', true);

  // Completing a completion-based repeat rolls it forward instead of closing.
  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Daily standup'));
    li.querySelector('.task-check').click();
  })()`);
  await sleep(200);
  check('completion-based repeat rolls forward', await evalJs(`document.getElementById('task-list').textContent.includes('Daily standup')`));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('harness completed', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
