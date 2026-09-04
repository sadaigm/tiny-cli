/**
 * Headless render smoke test for ported OpenTUI components (migration
 * phases 2–5). Run directly with bun — no terminal needed:
 *
 *   cd packages/cli && bun test/opentui-smoke.tsx
 *
 * Mounts each ported component with representative props and prints the
 * captured character frame. Exits non-zero if an expected marker is missing.
 */
import { testRender } from '@opentui/react/test-utils';
import Header from '../src/tui/components/Header.js';
import StatusBar from '../src/tui/components/StatusBar.js';
import MarkdownBody from '../src/tui/components/MarkdownBody.js';
import MessageItem from '../src/tui/components/MessageItem.js';
import { markdownToLines } from '../src/tui/utils/markdown.js';
import type { LogEntry } from '../src/tui/state.js';

let failures = 0;

async function smoke(name: string, node: React.ReactElement, checks: string[]): Promise<void> {
  const setup = await testRender(node, { width: 80, height: 24 });
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    const missing = checks.filter((c) => !frame.includes(c));
    if (missing.length > 0) {
      failures++;
      console.log(`✗ ${name} — missing: ${missing.join(', ')}\n${frame}`);
    } else {
      console.log(`✓ ${name}`);
    }
  } finally {
    setup.renderer.destroy();
  }
}

function entry(partial: Partial<LogEntry>): LogEntry {
  return { id: `e-${Math.random()}`, type: 'assistant', content: '', timestamp: Date.now(), ...partial };
}

await smoke('Header', <Header model="gpt-4o" endpoint="http://localhost" sessionId="s123" version="1.0" />, [
  'tiny-cli',
  'Session:',
]);

await smoke(
  'StatusBar',
  <StatusBar mode="agent" contextStats={{ tokens: 4200, characters: 16800 }} permissionMode="notify" cwd="/home/x/proj" />,
  ['[agent]', 'proj', 'tok'],
);

const md = markdownToLines(
  '# Title\n\nSome **bold** and `code` text with https://example.com link.\n\n- item one\n- item two\n',
  76,
);
await smoke('MarkdownBody', <MarkdownBody lines={md} />, ['Title', 'bold', 'item one']);

await smoke(
  'MessageItem(user)',
  <MessageItem entry={entry({ type: 'user', content: 'hello there\nsecond line' })} columns={80} />,
  ['hello there'],
);

await smoke(
  'MessageItem(assistant in turn)',
  <MessageItem entry={entry({ type: 'assistant', content: 'Answer with **markdown**.' })} columns={80} inTurn />,
  ['markdown'],
);

await smoke(
  'MessageItem(tool_call)',
  <MessageItem
    entry={entry({ type: 'tool_call', toolName: 'read_file', toolArgs: '{"path":"/tmp/x.ts"}', content: '' })}
    columns={80}
  />,
  ['read_file'],
);

await smoke(
  'MessageItem(error expanded)',
  <MessageItem entry={entry({ type: 'error', content: 'boom\nstack line 2\nstack line 3' })} columns={80} expanded />,
  ['boom'],
);

if (failures > 0) {
  console.log(`\n${failures} smoke failure(s)`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
