/**
 * Stable id for a JS error: message, file and line, nothing else.
 * Stack traces differ between runs, so they do not take part in the id.
 */
export function fingerprint(message: string, source: string | null, line: number | null): string {
  const text = `${message}\n${source ?? ''}\n${line ?? ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
