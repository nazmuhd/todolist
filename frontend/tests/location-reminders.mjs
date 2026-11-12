/* Location reminders: a reminder that fires when you are near a place.
 *
 * The browser's geolocation is mocked, so the test runs without a real
 * position and without asking for the permission.
 *
 * Run with `pnpm test:smoke`.
 */
import { createHarness, sleep } from './harness.mjs';

const h = await createHarness({ port: 5180, debugPort: 9316 });
const { send, evalJs, waitFor, check, errors } = h;

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  // Mock the Geolocation API before the app boots, so the watcher picks it
  // up and the permission is granted without a prompt.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__geo = { lat: 51.5074, lon: -0.1278 };
      window.__geoWatchers = [];
      const mock = {
        getCurrentPosition(success) {
          setTimeout(() => success({ coords: { latitude: window.__geo.lat, longitude: window.__geo.lon } }), 10);
        },
        watchPosition(success) {
          window.__geoWatchers.push(success);
          setTimeout(() => success({ coords: { latitude: window.__geo.lat, longitude: window.__geo.lon } }), 10);
          return window.__geoWatchers.length;
        },
        clearWatch() {},
      };
      // navigator.geolocation is a read-only getter, so it has to be
      // redefined rather than assigned.
      Object.defineProperty(navigator, 'geolocation', { value: mock, configurable: true });
    `,
  });

  await send('Page.reload');
  await waitFor('window.__appReady === true', 'app ready');
  await sleep(500);

  check('geolocation is mocked', await evalJs(`!!navigator.geolocation && typeof navigator.geolocation.watchPosition === 'function'`));

  // Use the UI: open the quick add, then the due editor.
  await evalJs(`document.getElementById('quick-add-placeholder').click()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Buy milk nearby';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Buy milk nearby')`, 'task created');

  // Open the task modal and its due editor.
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Buy milk nearby'));
    if (row) row.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'task modal open');
  await sleep(300);
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'due modal open');
  await sleep(300);

  // Add a reminder and switch it to a location one.
  await evalJs(`document.getElementById('due-add-reminder').click()`);
  await sleep(300);
  check('the reminder kind has a location option', await evalJs(`(() => {
    const sel = document.querySelector('[data-reminder-kind]');
    return !!sel && [...sel.options].some(o => o.value === 'location');
  })()`));

  await evalJs(`(() => {
    const sel = document.querySelector('[data-reminder-kind]');
    sel.value = 'location';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  check('the location fields appear', await evalJs(`!!document.querySelector('[data-reminder-lat]') && !!document.querySelector('[data-reminder-lon]')`));
  check('there is a button to use the current location', await evalJs(`!!document.querySelector('[data-reminder-use-location]')`));

  // Fill in a location near the mocked position.
  await evalJs(`(() => {
    const lat = document.querySelector('[data-reminder-lat]');
    const lon = document.querySelector('[data-reminder-lon]');
    const radius = document.querySelector('[data-reminder-radius]');
    lat.value = '51.5074';
    lat.dispatchEvent(new Event('change', { bubbles: true }));
    lon.value = '-0.1278';
    lon.dispatchEvent(new Event('change', { bubbles: true }));
    radius.value = '200';
    radius.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);

  // Save the task. The due editor commits its changes with "Done"; the
  // close button rolls them back.
  await evalJs(`document.getElementById('due-done').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('modal-save').click()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'task saved');
  await sleep(1500);

  // The watcher is armed by the save; nudge it with a position update.
  await evalJs(`(() => {
    if (window.__geoWatchers && window.__geoWatchers.length) {
      window.__geoWatchers.forEach(fn => fn({ coords: { latitude: 51.5074, longitude: -0.1278 } }));
    }
  })()`);
  await sleep(800);

  check('the location watcher was armed', await evalJs(`!!(window.__geoWatchers && window.__geoWatchers.length)`),
    await evalJs(`JSON.stringify(window.__geoWatchers ? window.__geoWatchers.length : -1)`));

  const saved = await evalJs(`(() => {
    const db = indexedDB.open('todoist-clone-files');
    return new Promise(res => {
      db.onsuccess = () => {
        const tx = db.result.transaction('docs','readonly');
        const g = tx.objectStore('docs').get('todoist-clone-v1');
        g.onsuccess = () => {
          const tasks = (g.result && g.result.value && g.result.value.tasks) || [];
          res(JSON.stringify(tasks.map(t => ({ title: t.title, r: t.reminders }))));
        };
        g.onerror = () => res('read error');
      };
      db.onerror = () => res('open error');
    });
  })()`);
  console.log('SAVED STATE:', saved);
  check('the task kept its location reminder', String(saved).includes('lat'), String(saved));

  check('a location reminder fires for a nearby position', await evalJs(`document.body.textContent.includes('Buy milk nearby') && !!document.querySelector('.toast')`),
    await evalJs(`[...document.querySelectorAll('[class*=toast]')].map(t=>t.textContent).join(' | ')`));

  // A second task with a reminder far away must NOT fire for this position
  // (Paris is about 340 km from London).
  await evalJs(`(() => {
    document.getElementById('quick-add-placeholder').click();
  })()`);
  await waitFor(`!document.getElementById('quick-add-editor').classList.contains('hidden')`, 'quick add open again');
  await evalJs(`(() => {
    const t = document.getElementById('quick-add-input');
    t.value = 'Far away task';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('quick-add-submit').click();
  })()`);
  await waitFor(`document.getElementById('task-list').textContent.includes('Far away task')`, 'second task created');
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('#task-list li[data-task-id]')].find(x => x.textContent.includes('Far away task'));
    if (row) row.querySelector('.task-edit').click();
  })()`);
  await waitFor(`document.getElementById('task-modal').open`, 'task modal open again');
  await sleep(300);
  await evalJs(`document.getElementById('meta-due').click()`);
  await waitFor(`document.getElementById('due-modal').open`, 'due modal open again');
  await sleep(300);
  await evalJs(`document.getElementById('due-add-reminder').click()`);
  await sleep(300);
  await evalJs(`(() => {
    const sel = document.querySelector('[data-reminder-kind]');
    sel.value = 'location';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  await evalJs(`(() => {
    const lat = document.querySelector('[data-reminder-lat]');
    const lon = document.querySelector('[data-reminder-lon]');
    const radius = document.querySelector('[data-reminder-radius]');
    lat.value = '48.8566';
    lat.dispatchEvent(new Event('change', { bubbles: true }));
    lon.value = '2.3522';
    lon.dispatchEvent(new Event('change', { bubbles: true }));
    radius.value = '200';
    radius.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  await evalJs(`document.getElementById('due-done').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('modal-save').click()`);
  await waitFor(`!document.getElementById('task-modal').open`, 'second task saved');
  await sleep(1200);

  // Nudge the watcher again and check the far task did not fire.
  await evalJs(`(() => {
    if (window.__geoWatchers && window.__geoWatchers.length) {
      window.__geoWatchers.forEach(fn => fn({ coords: { latitude: 51.5074, longitude: -0.1278 } }));
    }
  })()`);
  await sleep(700);
  check('a distant location reminder does not fire', await evalJs(`!document.body.textContent.includes('Far away task') || !document.body.textContent.includes('Reminder: Far away task')`),
    await evalJs(`[...document.querySelectorAll('[class*=toast]')].map(t=>t.textContent).join(' | ')`));

  const realErrors = errors.filter((e) => !/\/api\//.test(e) && !/ERR_INTERNET_DISCONNECTED/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));
} catch (err) {
  check('location reminder run', false, err.message);
  console.error(err);
} finally {
  const code = h.finish();
  await h.close();
  process.exit(code);
}
