// Browser stub for src/file-mention.ts. The real module uses Node fs/path to
// scan the workspace for @file-mentions — none of that exists in the browser.
// Web mode is for viewing/debugging the UI, so file-mentions are disabled:
// the index is empty and messages pass through unchanged on submit.
export async function buildFileIndex() {
  return [];
}
export function searchFiles() {
  return [];
}
export async function hydrateMessage(message) {
  return message;
}
