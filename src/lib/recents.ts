/**
 * Recently opened/saved Klipe projects, persisted in localStorage. Surfaced on
 * the recorder/launch screen so the user can reopen a project in one click.
 * Only metadata (path + name + timestamp) is stored — never project content.
 */

const RECENTS_KEY = 'klipe.recentProjects';
const MAX_RECENTS = 10;

export interface RecentProject {
  path: string;
  name: string;
  savedAt: number;
}

export function loadRecents(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((r) => r && typeof r.path === 'string' && r.path.length > 0);
  } catch {
    return [];
  }
}

/** Add (or move to front) a recent entry and return the updated list. */
export function addRecent(entry: { path: string; name: string }): RecentProject[] {
  if (!entry.path) return loadRecents();
  const rest = loadRecents().filter((r) => r.path !== entry.path);
  const next: RecentProject[] = [
    { path: entry.path, name: entry.name || 'Untitled', savedAt: Date.now() },
    ...rest,
  ].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  return next;
}

/** Remove an entry (e.g. when its folder no longer opens) and return the list. */
export function removeRecent(path: string): RecentProject[] {
  const next = loadRecents().filter((r) => r.path !== path);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
