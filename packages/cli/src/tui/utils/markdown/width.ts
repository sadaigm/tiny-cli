/** Ranges of code points that render as 2 terminal columns (CJK, emoji). */
const WIDE_CP = /[\u1100-\u115F\u2329-\u232A\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

/** Terminal columns the string occupies (wide chars count as 2). */
export function strWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += WIDE_CP.test(ch) ? 2 : 1;
  }
  return width;
}
