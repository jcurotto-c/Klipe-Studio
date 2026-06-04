/**
 * Renderer-side helpers for the recording library (<Videos>/KlipeStudio).
 *
 * The library is the source of truth for "my videos": every recording auto-saves
 * there (see {@link lib/project.saveProjectToLibrary}), so listing the folder
 * surfaces saved AND not-explicitly-saved takes alike. These wrap the
 * `window.klipe.library` IPC bridge with graceful no-op fallbacks for a non-
 * Electron / older build.
 */

/** List every saved recording, newest first. Empty array if unavailable. */
export async function listLibrary(): Promise<LibraryItem[]> {
  const bridge = window.klipe?.library;
  if (!bridge?.list) return [];
  try {
    return await bridge.list();
  } catch (e) {
    console.error('[library] list failed:', e);
    return [];
  }
}

/** Permanently delete a recording from the library. */
export async function deleteLibraryItem(projectPath: string): Promise<boolean> {
  const bridge = window.klipe?.library;
  if (!bridge?.delete) return false;
  try {
    const res = await bridge.delete(projectPath);
    return !!res?.ok;
  } catch (e) {
    console.error('[library] delete failed:', e);
    return false;
  }
}

/** Reveal a recording (or the library root) in the OS file manager. */
export async function revealLibraryItem(projectPath?: string): Promise<void> {
  const bridge = window.klipe?.library;
  if (!bridge?.reveal) return;
  try {
    await bridge.reveal(projectPath);
  } catch (e) {
    console.error('[library] reveal failed:', e);
  }
}

/** Absolute path of the library root, or null if unavailable. */
export async function getLibraryRoot(): Promise<string | null> {
  const bridge = window.klipe?.library;
  if (!bridge?.root) return null;
  try {
    return await bridge.root();
  } catch {
    return null;
  }
}
