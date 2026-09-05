/**
 * Public types of the markdown → terminal-line layout
 * (see ../markdown.ts for the module overview).
 */

/** One styled run of text inside a line. */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Set on `[text](url)` link spans; the renderer underlines them. */
  href?: string;
}

/** Visual style class of a laid-out line. */
export type MdLineStyle = 'text' | 'heading' | 'code' | 'quote' | 'bullet' | 'table' | 'hr';

/** One terminal row of laid-out markdown. */
export interface MdLine {
  style: MdLineStyle;
  /** Extra columns beyond the body indent (nested lists, code fence, quote). */
  indent: number;
  /** Styled runs; empty array for blank spacer lines (and hr markers). */
  spans: MdSpan[];
}
