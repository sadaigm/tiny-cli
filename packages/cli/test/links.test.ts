import { describe, it, expect } from 'vitest';
import { splitLinks } from '../src/tui/utils/links.js';

/** Reduce segments to [text, link] pairs for compact assertions. */
function pairs(text: string): [string, boolean][] {
  return splitLinks(text).map((s) => [s.text, s.link]);
}

describe('splitLinks — URLs', () => {
  it('splits a plain sentence with one URL', () => {
    expect(pairs('see https://example.com/docs for details')).toEqual([
      ['see ', false],
      ['https://example.com/docs', true],
      [' for details', false],
    ]);
  });

  it('keeps trailing punctuation out of the URL', () => {
    expect(pairs('go to https://example.com/x.')).toEqual([
      ['go to ', false],
      ['https://example.com/x', true],
      ['.', false],
    ]);
  });

  it('handles multiple URLs in one line', () => {
    const segs = splitLinks('https://a.io/1 then https://b.io/2');
    expect(segs.filter((s) => s.link).map((s) => s.text)).toEqual(['https://a.io/1', 'https://b.io/2']);
  });

  it('treats the whole string as one link when it is just a URL', () => {
    expect(pairs('https://example.com')).toEqual([['https://example.com', true]]);
  });
});

describe('splitLinks — filesystem paths', () => {
  it('highlights absolute paths with a file extension', () => {
    expect(pairs('edit src via /home/u/project/file.ts now')).toEqual([
      ['edit src via ', false],
      ['/home/u/project/file.ts', true],
      [' now', false],
    ]);
  });

  it('highlights multi-segment directories without an extension', () => {
    const segs = splitLinks('config lives in /etc/tiny-cli/ folder');
    expect(segs.filter((s) => s.link).map((s) => s.text)).toEqual(['/etc/tiny-cli/']);
  });

  it('does not highlight relative single-slash fragments', () => {
    expect(pairs('a/b is not a path')).toEqual([['a/b is not a path', false]]);
  });

  it('does not highlight slashes inside an URL (URL wins)', () => {
    const segs = splitLinks('see https://example.com/a/b/c end');
    expect(segs).toEqual([
      { text: 'see ', link: false },
      { text: 'https://example.com/a/b/c', link: true },
      { text: ' end', link: false },
    ]);
  });
});

describe('splitLinks — edge cases', () => {
  it('returns a single empty plain segment for empty input', () => {
    expect(splitLinks('')).toEqual([{ text: '', link: false }]);
  });

  it('returns plain text unchanged when nothing matches', () => {
    expect(pairs('just words, nothing else')).toEqual([['just words, nothing else', false]]);
  });

  it('handles a path at the very start of the string', () => {
    expect(pairs('/var/log/syslog rotated')).toEqual([
      ['/var/log/syslog', true],
      [' rotated', false],
    ]);
  });

  it('excludes trailing punctuation from a path', () => {
    expect(pairs('open /etc/passwd, please')).toEqual([
      ['open ', false],
      ['/etc/passwd', true],
      [', please', false],
    ]);
  });
});
