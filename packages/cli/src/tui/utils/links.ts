/**
 * Link detection for assistant/user message bodies.
 *
 * Splits text into plain and link segments so {@link MessageItem} can
 * underline URLs and absolute filesystem paths. Detection is deliberately
 * conservative: only `http://` / `https://` URLs and paths that start at a
 * word boundary with `/` and look like real file paths (no spaces, at
 * least one extension or second `/`) are highlighted — underlining every
 * slash-containing word would be noise.
 */

/** One segment of a split body: either plain text or a link. */
export interface TextSegment {
  /** The literal text of the segment. */
  text: string;
  /** True when this segment is a detected link. */
  link: boolean;
}

/**
 * URLs: http(s) with a host, trailing punctuation excluded.
 * Paths: absolute POSIX paths — no whitespace, at least 2 segments or a
 * dotted extension, and not part of a larger word (e.g. math `a/b`).
 */
const URL_RE = /https?:\/\/[^\s<>()"']+(?<![\s.,;:!?)\]])/g;
const PATH_RE = /(^|[\s(`\[])((?:\/[\w.@+-]+){2,}\/?)(?=$|[\s.,;:!?)\]'"])/g;

/**
 * Split `text` into plain/link segments, in order.
 *
 * URLs take priority over paths (an URL contains slashes but should never
 * be split). Regex matching is done in a single pass over URL hits first,
 * then paths inside the remaining plain spans.
 */
export function splitLinks(text: string): TextSegment[] {
  if (!text) return [{ text: '', link: false }];

  // Pass 1: carve out URLs.
  const afterUrls: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) afterUrls.push({ text: text.slice(last, start), link: false });
    afterUrls.push({ text: match[0], link: true });
    last = start + match[0].length;
  }
  if (last < text.length) afterUrls.push({ text: text.slice(last), link: false });

  // Pass 2: split paths inside the plain spans only.
  const result: TextSegment[] = [];
  for (const segment of afterUrls) {
    if (segment.link) {
      result.push(segment);
      continue;
    }
    let plainLast = 0;
    let anyPath = false;
    for (const match of segment.text.matchAll(PATH_RE)) {
      const prefix = match[1] ?? '';
      const start = (match.index ?? 0) + prefix.length;
      const path = match[2];
      if (start > plainLast) result.push({ text: segment.text.slice(plainLast, start), link: false });
      result.push({ text: path, link: true });
      plainLast = start + path.length;
      anyPath = true;
    }
    if (!anyPath) result.push(segment);
    else if (plainLast < segment.text.length) result.push({ text: segment.text.slice(plainLast), link: false });
  }

  return result.length > 0 ? result : [{ text: '', link: false }];
}
