import flatpickr from 'flatpickr';
import * as chrono from 'chrono-node';
import Sortable from 'sortablejs';
import * as rrule from 'rrule';
import { createIcons, icons } from 'lucide';

// Preserve existing global APIs used throughout the SPA source.
window.flatpickr = flatpickr;
window.chrono = chrono;
window.Sortable = Sortable;
window.rrule = rrule;
window.lucide = {
  createIcons: (opts) => createIcons({ icons, ...(opts || {}) }),
};
