import { createHash } from 'node:crypto';

/**
 * What a stranger's text should become in a rebuilt refusal, computed here
 * without calling src/frames.ts, so a test compares against an answer the code
 * under test did not produce.
 */
export function slot(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return `<${bytes.length} bytes, sha256:${createHash('sha256').update(bytes).digest('hex')}>`;
}
