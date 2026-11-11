/**
 * Shared singletons.
 *
 * Modules import these instead of relying on globals. The objects are
 * mutated in place so every importer always sees the current value.
 */
export const settings = {
  theme: 'system',
  startOfWeek: 'mon',
  dateFormat: 'system',
  timeFormat: 'system',
  defaultPriority: null,
  defaultReminder: null,
};
