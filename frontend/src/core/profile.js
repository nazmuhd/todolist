/**
 * The profile: the avatar shown in the sidebar and the name next to it.
 *
 * The app is a single-user, local-first tool, so there are no accounts and
 * nothing to sign in to. The profile is just a name, a subtitle, a status
 * and a picture, all stored with the other settings, and the picture is
 * chosen from the avatars that ship with the app.
 */

/** The pictures the picker offers. The logo is the default. */
export const AVATARS = [
  { id: 'logo', src: '/images/logo.png', label: 'Todolist logo' },
  { id: 'avatar-1', src: '/images/avatar-1.png', label: 'Avatar 1' },
  { id: 'avatar-2', src: '/images/avatar-2.png', label: 'Avatar 2' },
  { id: 'avatar-3', src: '/images/avatar-3.png', label: 'Avatar 3' },
  { id: 'avatar-4', src: '/images/avatar-4.png', label: 'Avatar 4' },
];

export const AVATAR_PATHS = AVATARS.map(a => a.src);

/** The statuses the dot beside the avatar can show. */
export const STATUSES = [
  { id: 'online', label: 'Online' },
  { id: 'busy', label: 'Busy' },
  { id: 'away', label: 'Away' },
  { id: 'sleepy', label: 'Sleepy' },
];

export const STATUS_IDS = STATUSES.map(s => s.id);

export const DEFAULT_PROFILE = {
  name: 'Todolist',
  job: 'Local workspace',
  status: 'online',
  avatar: AVATARS[0].src,
};

/** Fills in anything the stored profile is missing or holds a bad value. */
export function normaliseProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : DEFAULT_PROFILE.name,
    job: typeof p.job === 'string' ? p.job : DEFAULT_PROFILE.job,
    status: STATUS_IDS.includes(p.status) ? p.status : DEFAULT_PROFILE.status,
    avatar: AVATAR_PATHS.includes(p.avatar) ? p.avatar : DEFAULT_PROFILE.avatar,
  };
}
