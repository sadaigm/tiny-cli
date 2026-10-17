import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { hydrateMessage, rehydrateSessionImages, isImagePath } from '../src/file-mention.js';
import type { Message } from '@tiny-cli/core';

/**
 * Image-mention hydration tests (design: image_processing-design.md §5).
 *
 * `hydrateMessage` resolves mentions against process.cwd(), so these tests
 * chdir into a scratch workspace with fixture files.
 */
describe('hydrateMessage (images)', () => {
  const prevCwd = process.cwd();
  let root: string;
  /** Smallest valid 1×1 red PNG. */
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-cli-img-'));
    await fs.writeFile(path.join(root, 'a.png'), PNG_BYTES);
    await fs.writeFile(path.join(root, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    await fs.writeFile(path.join(root, 'notes.md'), 'hello notes');
    process.chdir(root);
  });

  afterAll(async () => {
    process.chdir(prevCwd);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('classifies image vs text vs unknown extensions', () => {
    expect(isImagePath('a.png')).toBe(true);
    expect(isImagePath('a.PNG')).toBe(true); // case-insensitive
    expect(isImagePath('dir/b.jpeg')).toBe(true);
    expect(isImagePath('c.webp')).toBe(true);
    expect(isImagePath('c.gif')).toBe(true);
    expect(isImagePath('notes.md')).toBe(false);
    expect(isImagePath('noext')).toBe(false);
    expect(isImagePath('archive.png.gz')).toBe(false);
  });

  it('attaches an image as base64 and marks its spot in the text', async () => {
    const { text, images } = await hydrateMessage('what is [@a.png]?', { vision: true });

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      path: 'a.png',
      mimeType: 'image/png',
      data: PNG_BYTES.toString('base64'),
    });
    expect(text).toContain('what is [image: a.png]?');
    // The raw base64 never rides in the text.
    expect(text).not.toContain(images[0].data);
  });

  it('keeps text mentions as <file> blocks in the same message', async () => {
    const { text, images } = await hydrateMessage('see [@notes.md] and [@a.png]', { vision: true });

    expect(images).toHaveLength(1);
    expect(text).toContain('<file path="notes.md">\nhello notes\n</file>');
    expect(text).toContain('see [@notes.md] and [image: a.png]');
  });

  it('skips images with an explicit note when the profile has no vision', async () => {
    const { text, images } = await hydrateMessage('what is [@a.png]?', { vision: false });

    expect(images).toHaveLength(0);
    expect(text).toContain('[image @a.png skipped — model has no vision]');
    // The mention token stays as typed (nothing was hydrated).
    expect(text).toContain('what is [@a.png]?');
  });

  it('defaults to no vision when the flag is omitted', async () => {
    const { images } = await hydrateMessage('[@a.png]');
    expect(images).toHaveLength(0);
  });

  it('skips oversize images (>5 MB) with a note', async () => {
    const { text, images } = await hydrateMessage('[@big.png]', { vision: true });

    expect(images).toHaveLength(0);
    expect(text).toContain('[image @big.png skipped — file too large (>5 MB)]');
  });

  it('degrades an unreadable image to a missing note', async () => {
    const { text, images } = await hydrateMessage('[@gone.png]', { vision: true });

    expect(images).toHaveLength(0);
    expect(text).toContain('[image @gone.png missing — unreadable]');
  });

  it('returns the message unchanged (no images) when there are no mentions', async () => {
    const result = await hydrateMessage('plain question', { vision: true });
    expect(result).toEqual({ text: 'plain question', images: [] });
  });
});

describe('rehydrateSessionImages', () => {
  const prevCwd = process.cwd();
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiny-cli-img-load-'));
    await fs.writeFile(path.join(root, 'shot.png'), Buffer.from('pngbytes'));
    process.chdir(root);
  });

  afterAll(async () => {
    process.chdir(prevCwd);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('re-reads path-only attachments from disk', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'look [image: shot.png]', images: [{ path: 'shot.png', mimeType: 'image/png' }] },
    ];
    const [m] = await rehydrateSessionImages(messages);

    expect(m.images).toHaveLength(1);
    expect(m.images![0].data).toBe(Buffer.from('pngbytes').toString('base64'));
    expect(m.content).toBe('look [image: shot.png]'); // text untouched
  });

  it('degrades missing files to a note and drops the attachment', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'look [image: gone.png]', images: [{ path: 'gone.png', mimeType: 'image/png' }] },
    ];
    const [m] = await rehydrateSessionImages(messages);

    expect(m.images).toBeUndefined();
    expect(m.content).toContain('[image @gone.png missing]');
  });

  it('keeps attachments that already carry data, passes others through', async () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'with data', images: [{ path: 'x.png', mimeType: 'image/png', data: 'AAAA' }] },
    ];
    const [a, u] = await rehydrateSessionImages(messages);

    expect(a).toEqual({ role: 'assistant', content: 'hi' });
    expect(u.images).toEqual([{ path: 'x.png', mimeType: 'image/png', data: 'AAAA' }]);
  });
});
