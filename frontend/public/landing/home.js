function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Interactive Hero App State */
const heroData = {
  today: [
    { id: 1, text: 'Review Q4 product strategy deck', due: '10:00 AM', project: '#Work', projectColor: 'text-td-blue', ring: 'border-td-red', done: false },
    { id: 2, text: 'Pick up fresh groceries & coffee beans', due: '5:30 PM', project: '#Groceries', projectColor: 'text-td-green', ring: 'border-td-orange', done: false },
    { id: 3, text: '30-minute evening run', due: '7:00 PM', project: '#Fitness', projectColor: 'text-td-orange', ring: 'border-td-blue', done: false },
    { id: 4, text: 'Confirm dentist appointment', due: 'Today', project: '#Appointments', projectColor: 'text-td-purple', ring: 'border-gray-400', done: false },
  ],
  inbox: [
    { id: 101, text: 'Research flights for December trip', due: 'No date', project: 'Inbox', projectColor: 'text-td-blue', ring: 'border-gray-400', done: false },
    { id: 102, text: 'Read "Build" by Tony Fadell', due: 'No date', project: 'Inbox', projectColor: 'text-td-blue', ring: 'border-gray-400', done: false },
  ],
  upcoming: [
    { id: 201, text: 'Prepare Monday team standup agenda', due: 'Mon 9:00 AM', project: '#Work', projectColor: 'text-td-blue', ring: 'border-td-red', done: false },
    { id: 202, text: 'Renew annual car insurance', due: 'Wed Nov 18', project: '#Personal', projectColor: 'text-td-green', ring: 'border-td-orange', done: false },
    { id: 203, text: 'Book dinner reservation for Friday', due: 'Fri Nov 20', project: '#Personal', projectColor: 'text-td-green', ring: 'border-gray-400', done: false },
  ]
};

let currentHeroView = 'today';

function renderHeroTasks() {
  const listEl = document.getElementById('hero-task-list');
  const titleEl = document.getElementById('hero-view-title');
  const subtitleEl = document.getElementById('hero-task-subtitle');
  const todayCountEl = document.getElementById('hero-today-count');
  if (!listEl) return;

  const tasks = heroData[currentHeroView];
  const remaining = tasks.filter(t => !t.done).length;

  if (titleEl) titleEl.textContent = currentHeroView.charAt(0).toUpperCase() + currentHeroView.slice(1);
  if (subtitleEl) subtitleEl.textContent = `${remaining} task${remaining === 1 ? '' : 's'}`;
  if (todayCountEl) todayCountEl.textContent = heroData.today.filter(t => !t.done).length;

  listEl.innerHTML = tasks.map(t => `
    <div class="py-2.5 flex items-start gap-3 group ${t.done ? 'opacity-50' : ''}">
      <button
        data-hero-toggle="${escapeHtml(t.id)}"
        aria-label="Complete task"
        class="task-check mt-0.5 w-[18px] h-[18px] rounded-full border-2 ${t.done ? 'bg-gray-400 border-gray-400 text-white' : t.ring} flex items-center justify-center flex-shrink-0"
      >
        ${t.done ? '<i data-lucide="check" class="w-3 h-3"></i>' : ''}
      </button>
      <div class="flex-1 min-w-0">
        <div class="text-xs sm:text-[13px] font-medium text-td-text ${t.done ? 'line-through' : ''}">${escapeHtml(t.text)}</div>
        <div class="mt-1 flex items-center gap-3 text-[11px] text-td-muted">
          <span class="flex items-center gap-1 text-td-green"><i data-lucide="calendar" class="w-3 h-3"></i> ${escapeHtml(t.due)}</span>
          <span class="ml-auto font-medium ${t.projectColor}">${escapeHtml(t.project)}</span>
        </div>
      </div>
    </div>
  `).join('');

  if (window.lucide?.createIcons) lucide.createIcons();
}

function toggleHeroTask(id) {
  const task = heroData[currentHeroView].find(t => t.id === id);
  if (task) {
    task.done = !task.done;
    renderHeroTasks();
  }
}

function addHeroTask(e) {
  e.preventDefault();
  const input = document.getElementById('hero-quick-input');
  const val = input?.value.trim();
  if (!val) return;

  heroData[currentHeroView].unshift({
    id: Date.now(),
    text: val,
    due: 'Today',
    project: '#Personal',
    projectColor: 'text-td-green',
    ring: 'border-td-red',
    done: false
  });
  input.value = '';
  renderHeroTasks();
}

function focusHeroInput() {
  document.getElementById('hero-quick-input')?.focus();
}

/* Sidebar View Switching */
document.querySelectorAll('.hero-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentHeroView = btn.dataset.view;
    document.querySelectorAll('.hero-nav-btn').forEach(b => {
      b.classList.remove('bg-td-redsoft', 'text-td-red', 'font-semibold');
      b.classList.add('text-td-secondary');
    });
    btn.classList.add('bg-td-redsoft', 'text-td-red', 'font-semibold');
    btn.classList.remove('text-td-secondary');
    renderHeroTasks();
  });
});

/* Layout Switcher (Calendar vs Board) */
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.layout;
    document.querySelectorAll('.layout-btn').forEach(b => {
      b.classList.remove('bg-white', 'text-td-text', 'shadow-sm');
      b.classList.add('text-td-secondary');
    });
    btn.classList.add('bg-white', 'text-td-text', 'shadow-sm');
    btn.classList.remove('text-td-secondary');

    document.getElementById('layout-calendar')?.classList.toggle('hidden', mode !== 'calendar');
    document.getElementById('layout-board')?.classList.toggle('hidden', mode !== 'board');
  });
});

/* Navbar border on scroll */
window.addEventListener('scroll', () => {
  const nav = document.getElementById('navbar');
  if (!nav) return;
  if (window.scrollY > 12) {
    nav.classList.add('border-gray-200/80', 'shadow-sm');
  } else {
    nav.classList.remove('border-gray-200/80', 'shadow-sm');
  }
});

/* Mobile menu */
document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
  document.getElementById('mobile-menu')?.classList.toggle('hidden');
});

document.getElementById('hero-add-task-btn')?.addEventListener('click', focusHeroInput);
document.getElementById('hero-quick-form')?.addEventListener('submit', addHeroTask);
document.getElementById('hero-task-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-hero-toggle]');
  if (!btn) return;
  toggleHeroTask(Number(btn.dataset.heroToggle));
});

/* Scroll fade-up animation */
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) e.target.classList.add('visible');
  });
}, { threshold: 0.12 });
document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));

renderHeroTasks();
if (window.lucide?.createIcons) lucide.createIcons();