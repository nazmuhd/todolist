/* A backup exported by an older build (app: 'todoist-clone', file named
 * todoist-backup-*.json) must still import. The format is detected from the
 * contents, not the name or the app field.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5183, debugPort: 9319 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(400);

  // A legacy backup, exactly as an older build wrote it.
  const legacy = JSON.stringify({
    app: 'todoist-clone',
    schemaVersion: 3,
    exportedAt: '2026-11-11T07:08:06.011Z',
    data: {
      projects: [{ id: 'proj_default', name: 'Work', color: '#246fe0' }],
      labels: [{ id: 'lbl_urgent', name: 'urgent', color: '#db4c3f' }],
      tasks: [
        { id: 'old_task_1', title: 'From an old backup', completed: false, projectId: null, labels: [], priority: 4, order: 0 },
        { id: 'old_task_2', title: 'Old backup task with project', completed: false, projectId: 'proj_default', labels: ['lbl_urgent'], priority: 4, order: 1 },
      ],
      templates: [],
    },
  });

  await evalJs(`(() => { window.confirm = () => true; })()`);
  await evalJs(`(() => {
    const input = document.getElementById('import-file');
    const file = new File([${JSON.stringify(legacy)}], 'todoist-backup-2026-11-11.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await waitFor(`document.getElementById('task-list').textContent.includes('From an old backup')`, 'legacy backup imported');
  check('a legacy backup still imports', true);
  check('its task is there', (await evalJs(`document.getElementById('task-list').textContent`)).includes('From an old backup'));
  check('its project is there too', (await evalJs(`document.getElementById('sidebar').textContent`)).includes('Work'));
  check('its label is there too', (await evalJs(`document.getElementById('sidebar').textContent`)).includes('urgent'));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('legacy import run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
