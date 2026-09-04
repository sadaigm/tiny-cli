import React from 'react';
import { Box, Text } from '../compat.js';
import type { MdLine, MdSpan } from '../utils/markdown.js';
import { splitLinks } from '../utils/links.js';
import { getTheme } from '../theme.js';

/**
 * Render pre-laid-out {@link MdLine}s produced by {@link markdownToLines}.
 *
 * Pure presentation: every width/layout decision was already made by the
 * layout function, so this component contains no wrapping math — that
 * separation is what keeps rendering and line counting in sync (see
 * MessageLog's `estimateLines`, which counts the same MdLine array).
 *
 * Style classes:
 * - `heading` → bold + theme accent
 * - `quote`   → dimmed
 * - `code`    → theme accent (content is verbatim)
 * - `hr`      → dim rule (the dashes were drawn at layout time)
 * - `table`   → spans carry grid chrome + cells; header bolded by layout
 * - `bullet`  → marker `•` / `N.` kept in `spans`[0], item text after it
 *
 * Inline spans carry `bold` / `italic` / `strike` / `code` (inverted) /
 * `href` (underlined). Raw URLs inside a span are also underlined, via
 * {@link splitLinks} — matching the pre-markdown renderer's behaviour.
 */
export default function MarkdownBody({ lines, color }: {
  lines: MdLine[];
  /** Entry body colour; styled lines (code/quote/hr/heading) take their own. */
  color?: string;
}): React.ReactElement {
  const theme = getTheme();
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} marginLeft={line.indent}>
          {renderLine(line, color, theme.accent)}
        </Box>
      ))}
    </Box>
  );
}

/** Render one laid-out line inside its (already-indented) row Box. */
function renderLine(line: MdLine, color: string | undefined, accent: string): React.ReactElement {
  switch (line.style) {
    case 'heading':
      return (
        <Text bold color={accent}>
          {line.spans.map((s, i) => renderSpan(s, i, true))}
        </Text>
      );
    case 'quote':
      return <Text dimColor>{line.spans.map((s, i) => renderSpan(s, i))}</Text>;
    case 'code':
      return <Text color={accent}>{line.spans.map((s, i) => renderSpan(s, i))}</Text>;
    case 'hr':
      return <Text dimColor>{line.spans.map((s, i) => renderSpan(s, i))}</Text>;
    case 'table':
      // Grid chrome (borders/padding) is plain spans; cells keep their
      // inline styling. The header row's spans were bolded at layout time.
      return <Text>{line.spans.map((s, i) => renderSpan(s, i))}</Text>;
    default:
      // 'text' and 'bullet' (marker lives in spans[0] as a plain span).
      return <Text color={color}>{line.spans.map((s, i) => renderSpan(s, i))}</Text>;
  }
}

/** Render one {@link MdSpan} with its inline styling applied. */
function renderSpan(span: MdSpan, key: number, boldAll = false): React.ReactElement {
  const segments = splitLinks(span.text);
  const base = {
    bold: span.bold || boldAll,
    italic: span.italic,
    strikethrough: span.strike,
    inverse: span.code,
  };
  if (!segments.some((s) => s.link)) {
    return (
      <Text key={key} {...base} underline={span.href !== undefined}>
        {span.text}
      </Text>
    );
  }
  return (
    <Text key={key} {...base}>
      {segments.map((seg, i) =>
        seg.link || span.href !== undefined ? (
          <Text key={i} underline>{seg.text}</Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}
