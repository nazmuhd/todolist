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

  // ---- Section 2: views, sorting, calendar scales, filters, drag. ----

  // Per-view sort is remembered when leaving and returning to a view.
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(120);
  await evalJs(`document.getElementById('sort-menu-btn').click()`);
  await waitFor(`!document.getElementById('sort-menu').classList.contains('hidden')`, 'sort menu open');
  await evalJs(`document.querySelector('#sort-menu [data-sort="name"]').click()`);
  await sleep(120);
  await evalJs(`document.querySelector('[data-view="today"]').click()`);
  await sleep(120);
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(120);
  await evalJs(`document.getElementById('sort-menu-btn').click()`);
  await waitFor(`!document.getElementById('sort-menu').classList.contains('hidden')`, 'sort menu reopened');
  check('per-view sort is remembered', await evalJs(`document.querySelector('#sort-menu [data-sort="name"]').classList.contains('text-td-red')`));
  await evalJs(`document.getElementById('sort-menu').classList.add('hidden')`);

  // Filter operators: search: and has:deadline.
  await evalJs(`(() => {
    const i = document.getElementById('search-input');
    i.value = 'search:Daily';
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await sleep(150);
  check('search: filter operator works', await evalJs(`document.getElementById('task-list').textContent.includes('Daily standup')`));
  await evalJs(`(() => {
    const i = document.getElementById('search-input');
    i.value = 'has:deadline';
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await sleep(150);
  check('has:deadline filter operator works', await evalJs(`(() => {
    const text = document.getElementById('task-list').textContent;
    return text.includes('Daily standup') && !text.includes('Tomorrow');
  })()`));
  await evalJs(`(() => {
    const i = document.getElementById('search-input');
    i.value = '';
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await sleep(120);

  // Calendar scales: month → week → day.
  await evalJs(`document.querySelector('[data-view="calendar"]').click()`);
  await waitFor(`!!document.querySelector('#calendar-view [data-cal-scale="month"]')`, 'calendar month scale');
  check('calendar starts in month scale', await evalJs(`!!document.querySelector('#calendar-view .cal-grid')`));
  await evalJs(`document.querySelector('#calendar-view [data-cal-scale="week"]').click()`);
  await waitFor(`!!document.querySelector('#calendar-view .cal-time-scroll')`, 'calendar week scale');
  check('week scale shows seven day columns', await evalJs(`document.querySelectorAll('#calendar-view .cal-time-col').length === 7`));
  await evalJs(`document.querySelector('#calendar-view [data-cal-scale="day"]').click()`);
  await waitFor(`document.querySelectorAll('#calendar-view .cal-time-col').length === 1`, 'calendar day scale');
  check('day scale shows one time column', await evalJs(`document.querySelectorAll('#calendar-view .cal-time-col').length === 1`));
  await evalJs(`document.querySelector('#calendar-view [data-cal-scale="month"]').click()`);
  await waitFor(`!!document.querySelector('#calendar-view .cal-grid')`, 'calendar back to month');

  // Board groups a project's tasks by section.
  await evalJs(`document.getElementById('add-project-btn').click()`);
  await waitFor(`document.getElementById('project-modal').open`, 'sections project modal');
  await evalJs(`(() => {
    const n = document.getElementById('project-name');
    n.value = 'Sections Project';
    n.dispatchEvent(new Event('input', {bubbles:true}));
    const sec = document.getElementById('project-section-name');
    sec.value = 'Alpha';
    document.getElementById('project-section-add').click();
    sec.value = 'Beta';
    document.getElementById('project-section-add').click();
    document.getElementById('save-project').click();
  })()`);
  await waitFor(`!![...document.querySelectorAll('.nav-item')].find(a => a.textContent.includes('Sections Project'))`, 'sections project created');
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(a => a.textContent.includes('Sections Project')).click()`);
  await sleep(150);
  await evalJs(`document.querySelector('[data-layout="board"]').click()`);
  await waitFor(`!!document.querySelector('#board-view .board-column')`, 'section board renders');
  check('board columns follow project sections', await evalJs(`(() => {
    const labels = [...document.querySelectorAll('#board-view .board-column[data-group="section"]')].map(c => c.textContent);
    return labels.length === 2 && labels.some(t => t.includes('Alpha')) && labels.some(t => t.includes('Beta'));
  })()`));

  // A task assigned to a section appears in that part's column.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add in section project');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Beta task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`!![...document.querySelectorAll('#board-view [data-task-id]')].find(c => c.textContent.includes('Beta task'))`, 'section task added');
  await evalJs(`(() => {
    const card = [...document.querySelectorAll('#board-view [data-task-id]')].find(c => c.textContent.includes('Beta task'));
    card.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'section task modal');
  await evalJs(`(() => {
    const sel = document.getElementById('modal-section');
    const beta = [...sel.options].find(o => o.textContent === 'Beta');
    sel.value = beta.value;
    sel.dispatchEvent(new Event('change', {bubbles:true}));
    document.getElementById('modal-save').click();
  })()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'section task saved');
  await sleep(150);
  check('a sectioned task lands in its section column', await evalJs(`(() => {
    const cols = [...document.querySelectorAll('#board-view .board-column[data-group="section"]')];
    const beta = cols.find(c => c.textContent.includes('Beta'));
    return !!beta && beta.textContent.includes('Beta task');
  })()`));

  // Upcoming day headers are drop targets for rescheduling.
  await evalJs(`document.querySelector('[data-view="upcoming"]').click()`);
  await sleep(150);
  const dragResult = await evalJs(`(() => {
    const headers = [...document.querySelectorAll('#task-list .day-group-header[data-day-group]')]
      .filter(h => /^\\d{4}-\\d{2}-\\d{2}$/.test(h.dataset.dayGroup));
    if (headers.length < 2) return { ok: false, reason: 'need two dated groups' };
    const from = headers[0];
    const to = headers[1];
    const row = from.nextElementSibling;
    if (!row || !row.matches('li[data-task-id]')) return { ok: false, reason: 'no row after header' };
    const id = row.dataset.taskId;
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, id, day: to.dataset.dayGroup };
  })()`);
  await sleep(200);
  if (dragResult && dragResult.ok) {
    check('dropping on a day header reschedules the task', await evalJs(`(() => {
      const row = document.querySelector('#task-list li[data-task-id="${dragResult.id}"]');
      if (!row) return false;
      let prev = row.previousElementSibling;
      while (prev && !prev.classList.contains('day-group-header')) prev = prev.previousElementSibling;
      return !!prev && prev.dataset.dayGroup === '${dragResult.day}';
    })()`));
  } else {
    check('dropping on a day header reschedules the task', false, dragResult && dragResult.reason);
  }

  // ---- Section 3: notification actions and custom reminder offsets. ----

  // Custom reminder offsets in the due editor.
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(120);
  await evalJs(`document.querySelector('[data-layout="list"]').click()`);
  await waitFor(`!document.getElementById('task-list').classList.contains('hidden')`, 'inbox back in list layout');
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add for notifications');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Notify me';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Notify me')`, 'notification task added');
  const notifyId = await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Notify me'));
    return li ? li.dataset.taskId : null;
  })()`);
  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Notify me'));
    li.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'notification task modal');
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'notification due modal');
  await evalJs(`(() => {
    const i = document.getElementById('due-nl');
    i.value = 'today';
    i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  })()`);
  await waitFor(`document.getElementById('due-nl-status').textContent.includes('Due')`, 'notification due parsed');
  await evalJs(`document.getElementById('due-add-reminder').click()`);
  await waitFor(`!!document.querySelector('#due-reminders [data-reminder-minutes]')`, 'reminder select present');
  await evalJs(`(() => {
    const sel = document.querySelector('#due-reminders [data-reminder-minutes]');
    sel.value = 'custom';
    sel.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await waitFor(`!document.querySelector('#due-reminders [data-reminder-custom]').classList.contains('hidden')`, 'custom reminder fields');
  check('custom reminder offset fields appear', await evalJs(`!!document.querySelector('#due-reminders [data-reminder-custom-value]') && !!document.querySelector('#due-reminders [data-reminder-custom-unit]')`));
  await evalJs(`(() => {
    const input = document.querySelector('#due-reminders [data-reminder-custom-value]');
    input.value = '45';
    input.dispatchEvent(new Event('input', {bubbles:true}));
    const unit = document.querySelector('#due-reminders [data-reminder-custom-unit]');
    unit.value = '1';
    unit.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await evalJs(`document.getElementById('due-done').click()`);
  await waitFor(`!document.getElementById('due-modal').open`, 'custom reminder due modal closed');
  await evalJs(`document.getElementById('modal-save').click()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'custom reminder saved');
  check('custom reminder survives saving', await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Notify me'));
    return !!li && !!li.querySelector('[data-lucide="bell"]');
  })()`));

  // Notification action link completes the task without opening its dialog.
  await evalJs(`location.hash = '#/action?action=complete&task=${notifyId}'`);
  await sleep(220);
  check('notification Complete action completes the task', await evalJs(`!document.getElementById('task-list').textContent.includes('Notify me')`));
  await evalJs(`document.querySelector('[data-view="completed"]').click()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Notify me')`, 'completed task visible');
  check('the completed task appears in Completed', true);

  // Snoozing only the reminder keeps the task in place.
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(120);
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add for snooze');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Snooze me';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Snooze me')`, 'snooze task added');
  const snoozeId = await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Snooze me'));
    return li ? li.dataset.taskId : null;
  })()`);
  // Give it a reminder through the due editor.
  await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Snooze me'));
    li.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'snooze task modal');
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'snooze due modal');
  await evalJs(`document.getElementById('due-add-reminder').click()`);
  await waitFor(`!!document.querySelector('#due-reminders [data-reminder-minutes]')`, 'snooze reminder row');
  await evalJs(`document.getElementById('due-done').click()`);
  await waitFor(`!document.getElementById('due-modal').open`, 'snooze due closed');
  await evalJs(`document.getElementById('modal-save').click()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'snooze task saved');
  check('snooze task starts with a reminder', await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Snooze me'));
    return !!li && !!li.querySelector('[data-lucide="bell"]');
  })()`));
  await evalJs(`location.hash = '#/action?action=snooze-10&task=${snoozeId}'`);
  await sleep(220);
  check('notification Snooze keeps the task open', await evalJs(`document.getElementById('task-list').textContent.includes('Snooze me')`));
  check('snoozed task still has a reminder', await evalJs(`(() => {
    const li = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Snooze me'));
    return !!li && !!li.querySelector('[data-lucide="bell"]');
  })()`));

  // ---- Move a task between sections from the context menu. ----
  await evalJs(`document.querySelector('[data-layout="list"]').click()`);
  await evalJs(`(() => {
    const link = [...document.querySelectorAll('.nav-item')].find(a => a.textContent.includes('Sections Project'));
    if (link) link.click();
  })()`);
  await sleep(180);
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Beta task'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
  })()`);
  await waitFor(`!document.getElementById('context-menu').classList.contains('hidden')`, 'section context menu');
  check('context menu offers project sections', await evalJs(`(() => {
    const text = document.getElementById('context-menu').textContent;
    return text.includes('Move to section') && text.includes('Alpha') && text.includes('Beta');
  })()`));
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('#context-menu [data-context-action^="section-"]')]
      .find(b => b.textContent.trim() === 'Alpha');
    if (btn) btn.click();
  })()`);
  await sleep(180);
  await evalJs(`document.querySelector('[data-layout="board"]').click()`);
  await sleep(180);
  check('context menu moves a task to a section', await evalJs(`(() => {
    const cols = [...document.querySelectorAll('#board-view .board-column[data-group="section"]')];
    const alpha = cols.find(c => c.textContent.includes('Alpha'));
    return !!alpha && alpha.textContent.includes('Beta task');
  })()`));

  // ---- Todoist JSON backup import. ----
  const todoistBackup = JSON.stringify({
    projects: [{ id: 'p1', name: 'Imported Project', color: 'blue' }],
    sections: [{ id: 's1', name: 'Later', project_id: 'p1' }],
    labels: [{ id: 'l1', name: 'errand', color: 'green' }],
    items: [
      {
        id: 'i1', content: 'Todoist task', description: 'From Todoist',
        project_id: 'p1', section_id: 's1', labels: ['errand'], priority: 4,
        due: { date: '2026-11-20T09:00:00', is_recurring: false, string: 'Nov 20 9:00' },
        child_order: 1, checked: 0, added_at: '2026-11-01T10:00:00Z',
      },
      { id: 'i2', content: 'Inbox task', project_id: null, priority: 1, child_order: 2, checked: 0 },
      {
        id: 'i3', content: 'Done already', project_id: 'p1', child_order: 3,
        checked: 1, completed_at: '2026-11-02T10:00:00Z',
      },
    ],
    notes: [{ id: 'n1', item_id: 'i1', content: 'A note', posted_at: '2026-11-01T11:00:00Z' }],
    reminders: [{ id: 'r1', item_id: 'i1', type: 'relative', minute_offset: 30 }],
  });
  await evalJs(`(() => { window.confirm = () => true; })()`);
  await evalJs(`(() => {
    const input = document.getElementById('import-file');
    const file = new File([${JSON.stringify(todoistBackup)}], 'todoist-backup.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Inbox task')`, 'Todoist backup imported');
  check('Todoist import replaces the task list', await evalJs(`!document.getElementById('task-list').textContent.includes('Beta task')`));
  check('Todoist import restores projects and labels', await evalJs(`(() => {
    const side = document.getElementById('sidebar').textContent;
    return side.includes('Imported Project') && side.includes('errand');
  })()`));
  await evalJs(`(() => {
    const link = [...document.querySelectorAll('.nav-item')].find(a => a.textContent.includes('Imported Project'));
    if (link) link.click();
  })()`);
  await sleep(180);
  check('Todoist task keeps project, section, label, priority, due and reminder', await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Todoist task'));
    if (!row) return false;
    const text = document.getElementById('task-list').textContent;
    return text.includes('Later') && text.includes('@errand') &&
      !!row.querySelector('.prio-marker.prio-1') && row.textContent.includes('Nov 20') &&
      !!row.querySelector('[data-lucide="bell"]');
  })()`));
  await evalJs(`document.querySelector('[data-view="completed"]').click()`);
  await sleep(180);
  check('Todoist import preserves completed tasks', await evalJs(`document.getElementById('task-list').textContent.includes('Done already')`));

  // ---- Undo survives a page reload. ----
  await evalJs(`document.querySelector('[data-view="inbox"]').click()`);
  await sleep(150);
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'undo quick add');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Undo after reload';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Undo after reload')`, 'undo task created');
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Undo after reload'));
    if (row) row.querySelector('.task-delete').click();
  })()`);
  await waitFor(`!document.getElementById('task-list').textContent.includes('Undo after reload')`, 'undo task deleted');
  await sleep(500); // let the history doc finish writing
  await send('Page.reload');
  await sleep(500);
  await waitFor('window.__appReady === true', 'app ready after reload');
  await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'z', ctrlKey:true, bubbles:true}))`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Undo after reload')`, 'undo restored after reload');
  check('undo history survives a reload', true);

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
