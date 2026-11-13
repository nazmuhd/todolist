/**
 * The task dialog: title, description, comments, sections, attachments,
 * the meta chips and their menus.
 *
 * The due-date dialog is a separate feature (`due-editor.js`); both edit the
 * same draft, which lives in `core/app.js`.
 */
import { $, $$, uid, modalState } from '../core/app.js';
import { state, saveState } from '../core/state.js';
import { store } from '../core/store.js';
import { cleanDuration, formatDue } from '../core/dates.js';
import { taskReminders, priorityColor, priorityLabel, projectName, labelName, removeTask } from '../core/tasks.js';
import { taskLevel } from '../core/priorities.js';
import { escapeHtml } from '../core/text.js';
import { renderMarkdown, renderMarkdownInline } from '../core/markdown.js';
import { requestRender } from '../core/render.js';
import { services } from '../core/services.js';
import { showToast } from '../core/toasts.js';
import { reminderKey, ensureNotificationPermission } from '../core/reminders.js';
import { recordActivity } from '../core/activity.js';
import { positionMetaMenu } from '../ui/menus.js';
import { renderChipMenu, closeChipMenus, initChipMenus } from './chip-menus.js';
import { commitDueEdits, recurrenceEndFromBody, closeDueEditor, isDueEditorOpen } from './due-editor.js';
import { saveTaskTemplate } from './templates.js';
import { setTaskHash, clearTaskHash } from '../core/router.js';

const modal = $('#task-modal');
const priorityMenu = $('#priority-menu');
const projectMenu = $('#project-menu');
const labelMenu = $('#label-menu');

const draft = () => modalState.draft;

export function isTaskModalOpen() {
  return modal.open;
}

export function closeTaskModal() {
  if (modal.open) modal.close();
}

/* ---------- Task modal: attachments ---------- */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Blobs added in this dialog but not saved are cleaned up when it closes.
const pendingAttachments = new Set();
const attachmentUrls = new Map();

function revokeAttachmentUrls() {
  attachmentUrls.forEach(url => URL.revokeObjectURL(url));
  attachmentUrls.clear();
}

function isImageAttachment(a) {
  return /^image\//i.test(a && a.type || '');
}

function fileToObjectUrl(id) {
  if (attachmentUrls.has(id)) return Promise.resolve(attachmentUrls.get(id));
  return store.getBlob(id).then((blob) => {
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    attachmentUrls.set(id, url);
    return url;
  }).catch(() => null);
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderModalAttachments() {
  const list = (draft() && Array.isArray(draft().attachments)) ? draft().attachments : [];
  $('#modal-attachments').classList.toggle('hidden', !list.length && !modalState.editingTaskId);
  $('#modal-attachment-list').innerHTML = list.map(a => {
    const image = isImageAttachment(a);
    return `
    <li class="flex items-center gap-2 text-xs">
      ${image
        ? `<span class="attachment-thumb flex-shrink-0" data-attachment-thumb="${escapeHtml(a.id)}"><i data-lucide="image" class="w-3 h-3 text-td-muted"></i></span>`
        : '<i data-lucide="paperclip" class="w-3 h-3 text-td-muted flex-shrink-0"></i>'}
      <button type="button" class="flex-1 text-left truncate hover:underline" data-attachment-open="${escapeHtml(a.id)}" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button>
      <span class="text-td-muted flex-shrink-0">${formatFileSize(a.size)}</span>
      <button type="button" class="text-td-muted hover:text-red-600 flex-shrink-0" data-attachment-remove="${escapeHtml(a.id)}" title="Remove attachment" aria-label="Remove attachment">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </li>`;
  }).join('');
  lucide.createIcons();
  // Thumbnails are loaded asynchronously from IndexedDB into object URLs.
  list.filter(isImageAttachment).forEach((a) => {
    fileToObjectUrl(a.id).then((url) => {
      if (!url || !modal.open) return;
      const holder = $(`[data-attachment-thumb="${a.id}"]`);
      if (!holder) return;
      holder.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(a.name)}" class="w-6 h-6 object-cover rounded" />`;
    });
  });
}

/** Stores the chosen/dropped files and adds them to the draft. */
async function addAttachmentFiles(files) {
  const list = [...(files || [])];
  if (!list.length || !draft()) return;
  if (!Array.isArray(draft().attachments)) draft().attachments = [];

  for (const file of list) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`${file.name} is larger than 25 MB`, 'error');
      continue;
    }
    const id = uid();
    try {
      await store.putBlob(id, file);
    } catch (err) {
      showToast(`Could not store ${file.name}`, 'error');
      continue;
    }
    pendingAttachments.add(id);
    draft().attachments.push({
      id,
      name: file.name,
      type: file.type,
      size: file.size,
      addedAt: Date.now(),
    });
  }
  renderModalAttachments();
}

$('#modal-attachment-add').onclick = () => $('#modal-attachment-input').click();

$('#modal-attachment-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  await addAttachmentFiles(files);
});

// Drag-and-drop: drop files anywhere on the attachments area.
const attachmentDropZone = $('#modal-attachments');
['dragenter', 'dragover'].forEach((type) => {
  attachmentDropZone.addEventListener(type, (e) => {
    if (!draft() || !e.dataTransfer) return;
    e.preventDefault();
    attachmentDropZone.classList.add('is-drop-target');
  });
});
['dragleave', 'dragend'].forEach((type) => {
  attachmentDropZone.addEventListener(type, () => {
    attachmentDropZone.classList.remove('is-drop-target');
  });
});
attachmentDropZone.addEventListener('drop', async (e) => {
  attachmentDropZone.classList.remove('is-drop-target');
  if (!draft() || !e.dataTransfer) return;
  e.preventDefault();
  await addAttachmentFiles(e.dataTransfer.files);
});

$('#modal-attachment-list').addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-attachment-open]');
  if (openBtn) {
    const id = openBtn.dataset.attachmentOpen;
    try {
      const blob = await store.getBlob(id);
      if (!blob) { showToast('That file is no longer stored', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (draft().attachments.find(a => a.id === id) || {}).name || 'file';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      showToast('Could not open that file', 'error');
    }
    return;
  }

  const removeBtn = e.target.closest('[data-attachment-remove]');
  if (!removeBtn) return;
  const id = removeBtn.dataset.attachmentRemove;
  draft().attachments = (draft().attachments || []).filter(a => a.id !== id);
  pendingAttachments.add(id);
  store.deleteBlob(id).catch(() => {});
  renderModalAttachments();
});

export function openTaskModal(id) {
  // Reopening replaces the previous dialog's thumbnails.
  revokeAttachmentUrls();
  modalState.editingTaskId = id;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  // The collections are copied so editing the draft never touches the task
  // until it is saved.
  modalState.draft = {
    ...t,
    labels: [...(t.labels || [])],
    comments: [...(t.comments || [])],
    attachments: [...(t.attachments || [])],
  };

  $('#modal-title').value = t.title;
  $('#modal-desc').value = t.description || '';
  $('#modal-desc-preview').innerHTML = renderMarkdown(t.description || '');
  $('#modal-desc-preview').classList.add('hidden');
  $('#modal-desc').classList.remove('hidden');
  $('#modal-duration').value = t.durationMinutes || '';
  updateModalChips();
  renderModalComments();
  renderModalSections();
  renderModalAttachments();
  setTaskHash(id);
  modal.showModal();
  // Don't open the on-screen keyboard on phones: it would cover the dialog.
  if (!services.isMobileSidebar()) setTimeout(() => $('#modal-title').focus(), 50);
}

$('#modal-desc-preview-btn').onclick = () => {
  const preview = $('#modal-desc-preview');
  const desc = $('#modal-desc');
  const showing = !preview.classList.contains('hidden');
  if (showing) {
    preview.classList.add('hidden');
    desc.classList.remove('hidden');
    $('#modal-desc-preview-btn').textContent = 'Preview';
  } else {
    preview.innerHTML = renderMarkdown(desc.value);
    preview.classList.remove('hidden');
    desc.classList.add('hidden');
    $('#modal-desc-preview-btn').textContent = 'Edit';
  }
};
$('#modal-desc').addEventListener('input', () => {
  if (!$('#modal-desc-preview').classList.contains('hidden')) {
    $('#modal-desc-preview').innerHTML = renderMarkdown($('#modal-desc').value);
  }
});

/* ---------- Task modal: comments and sections ---------- */
function renderModalComments() {
  const list = (draft() && Array.isArray(draft().comments)) ? draft().comments : [];
  $('#modal-comments').classList.remove('hidden');
  $('#modal-comment-list').innerHTML = list.map(c => `
    <li class="flex items-start gap-2 text-xs">
      <span class="flex-1 md-inline">${renderMarkdownInline(c.text)}</span>
      <button type="button" class="text-td-muted hover:text-red-600" data-comment-remove="${escapeHtml(c.id)}" title="Delete comment" aria-label="Delete comment">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </li>`).join('');
  lucide.createIcons();
}

function renderModalSections() {
  const wrap = $('#modal-section-wrap');
  const select = $('#modal-section');
  const t = draft() || {};
  const proj = state.projects.find(p => p.id === t.projectId);
  const sections = proj && Array.isArray(proj.sections) ? proj.sections : [];
  wrap.style.display = sections.length ? '' : 'none';
  select.innerHTML = `<option value="">No section</option>${
    sections.map(s => `<option value="${escapeHtml(s.id)}" ${t.sectionId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}`;
}

$('#modal-section').onchange = (e) => {
  draft().sectionId = e.target.value || null;
};

$('#modal-comment-add').onclick = () => {
  const input = $('#modal-comment-input');
  const text = input.value.trim();
  if (!text) return;
  if (!Array.isArray(draft().comments)) draft().comments = [];
  draft().comments.push({ id: uid(), text, createdAt: Date.now() });
  input.value = '';
  renderModalComments();
};

$('#modal-comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#modal-comment-add').click(); }
});

$('#modal-comment-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-comment-remove]');
  if (!btn) return;
  draft().comments = (draft().comments || []).filter(c => c.id !== btn.dataset.commentRemove);
  renderModalComments();
});

export function updateModalChips() {
  const t = draft();
  // due
  $('#meta-due-text').textContent = t.due ? `${formatDue(t.due, t.dueTime)}${t.recurrence ? ' ↻' : ''}` : 'Due date';
  $('#meta-due').classList.toggle('text-td-red', !!t.due);
  // priority: the built-in P1-P4, or the user's own level.
  const level = taskLevel(t);
  $('#meta-priority-text').textContent = level ? level.name : 'Priority';
  $('#meta-priority-icon').style.color = level ? level.color : '#999';
  $('#meta-priority-icon').setAttribute('fill', level && level.priority && level.priority < 4 ? level.color : 'none');
  // project
  $('#meta-project-text').textContent = t.projectId ? projectName(t.projectId) : 'Project';
  // labels
  const names = (t.labels || []).map(labelName).filter(Boolean);
  $('#meta-label-text').textContent = names.length ? names.map(n => '@' + n).join(', ') : 'Labels';
}

function renderPriorityMenu() {
  renderChipMenu('priority', draft());
}

function renderProjectMenu() {
  renderChipMenu('project', draft());
}

function renderLabelMenu() {
  renderChipMenu('label', draft());
}

/* ---------- The meta chip menus ---------- */

export function closeMetaMenus() {
  closeChipMenus();
}

function toggleMetaMenu(menu, trigger) {
  const opening = menu.classList.contains('hidden');
  closeMetaMenus();
  if (!opening) return;
  menu.classList.remove('hidden');
  positionMetaMenu(menu, trigger);
}

window.addEventListener('resize', () => {
  if (!priorityMenu.classList.contains('hidden')) positionMetaMenu(priorityMenu, $('#meta-priority'));
  if (!projectMenu.classList.contains('hidden')) positionMetaMenu(projectMenu, $('#meta-project'));
  if (!labelMenu.classList.contains('hidden')) positionMetaMenu(labelMenu, $('#meta-label'));
});
window.addEventListener('scroll', () => {
  if (!priorityMenu.classList.contains('hidden')) positionMetaMenu(priorityMenu, $('#meta-priority'));
  if (!projectMenu.classList.contains('hidden')) positionMetaMenu(projectMenu, $('#meta-project'));
  if (!labelMenu.classList.contains('hidden')) positionMetaMenu(labelMenu, $('#meta-label'));
}, true);


$$('.close-modal').forEach(b => b.onclick = () => modal.close());
modal.addEventListener('close', () => {
  // A rapid close-then-reopen dispatches the old close event late; keep the
  // new dialog's state and permalink in that case.
  if (modal.open) return;
  modalState.editingTaskId = null;
  modalState.draft = null;
  // Files added in the dialog but never saved are thrown away.
  pendingAttachments.forEach(id => store.deleteBlob(id).catch(() => {}));
  pendingAttachments.clear();
  revokeAttachmentUrls();
  $('#modal-attachments').classList.remove('is-drop-target');
  if (isDueEditorOpen()) closeDueEditor();
  clearTaskHash();
});

$('#modal-save').onclick = () => {
  const editingTaskId = modalState.editingTaskId;
  const modalDraft = draft();
  if (!editingTaskId || !modalDraft) return;
  if (!commitDueEdits()) {
    showToast('That repeat rule is not valid', 'error');
    $('#due-repeat').focus();
    return;
  }
  const t = state.tasks.find(x => x.id === editingTaskId);
  if (!t) return;
  const previousReminderKey = reminderKey(t);
  // The activity log records what actually changed, so the old values are
  // kept for the comparison.
  const before = {
    title: t.title,
    due: t.due,
    projectId: t.projectId,
    comments: (t.comments || []).length,
  };
  t.title = $('#modal-title').value.trim() || 'Untitled';
  t.description = $('#modal-desc').value.trim();
  t.due = modalDraft.due;
  t.dueTime = modalDraft.dueTime;
  t.deadline = modalDraft.deadline || null;
  t.deadlineTime = modalDraft.deadlineTime || null;
  t.recurrence = modalDraft.recurrence;
  t.recurrenceEnd = recurrenceEndFromBody(modalDraft.recurrence);
  t.recurrenceMode = modalDraft.recurrenceMode || 'scheduled';
  t.timeZone = modalDraft.timeZone || null;
  t.startDate = modalDraft.startDate || null;
  // Keep every kind of reminder: a time, an offset, or a place.
  t.reminders = taskReminders(modalDraft).map(r => {
    if (r.at) return { id: r.id, at: r.at };
    if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
      return { id: r.id, lat: r.lat, lon: r.lon, radius: r.radius, name: r.name || '' };
    }
    return { id: r.id, minutes: r.minutes };
  });
  t.reminderMinutes = t.reminders.find(r => Number.isInteger(r.minutes))?.minutes ?? null;
  t.comments = (modalDraft.comments || []).map(c => ({ ...c }));
  t.attachments = (modalDraft.attachments || []).map(a => ({ ...a }));
  // The files now belong to the task, so the close handler must not remove them.
  pendingAttachments.clear();
  t.sectionId = modalDraft.sectionId || null;
  if (reminderKey(t) !== previousReminderKey) t.reminderFiredKey = null;
  if (t.reminderMinutes !== null) ensureNotificationPermission();
  t.durationMinutes = cleanDuration(Number($('#modal-duration').value));
  t.priority = modalDraft.priority;
  t.customPriorityId = modalDraft.customPriorityId || null;
  t.projectId = modalDraft.projectId;
  t.labels = modalDraft.labels;
  saveState();
  requestRender();
  recordTaskEdit(t, before);
  modal.close();
};

/** Records what changed in the task modal, as one activity event. */
function recordTaskEdit(t, before) {
  const changes = [];
  if (t.title !== before.title) changes.push(`renamed to "${t.title}"`);
  if (t.due !== before.due) changes.push(t.due ? `due date set to ${t.due}` : 'due date removed');
  if (t.projectId !== before.projectId) {
    changes.push(t.projectId ? `moved to ${projectName(t.projectId)}` : 'removed from project');
  }
  const comments = (t.comments || []).length;
  if (comments > before.comments) changes.push('comment added');
  if (!changes.length) return;
  recordActivity(t.due !== before.due ? 'rescheduled' : 'edited', t, changes.join(', '));
}

$('#modal-save-template').onclick = () => {
  if (!draft()) return;
  saveTaskTemplate(draft());
};

$('#modal-copy-link').onclick = async () => {
  if (!modalState.editingTaskId) return;
  const link = `${location.origin}${location.pathname}#/task/${encodeURIComponent(modalState.editingTaskId)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast('Task link copied', 'success');
  } catch {
    showToast(link, 'info');
  }
};

$('#modal-delete').onclick = () => {
  if (!modalState.editingTaskId) return;
  const id = modalState.editingTaskId;
  modal.close();
  removeTask(id);
};

services.updateModalChips = updateModalChips;
services.closeMetaMenus = closeMetaMenus;
