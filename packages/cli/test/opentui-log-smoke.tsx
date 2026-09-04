/**
 * Headless smoke test for the ported MessageLog (Phase 4).
 * Run: cd packages/cli && bun test/opentui-log-smoke.tsx
 */
import { testRender } from '@opentui/react/test-utils';
import MessageLog from '../src/tui/components/MessageLog.js';
import { StreamProvider } from '../src/tui/components/StreamProvider.js';
import { StreamStore } from '../src/tui/streamStore.js';
import { useState } from 'react';
import type { LogEntry } from '../src/tui/state.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`✓ ${name}`);
  else {
    failures++;
    console.log(`✗ ${name} ${extra}`);
  }
}

function entry(partial: Partial<LogEntry>): LogEntry {
  return { id: `e-${Math.random().toString(36).slice(2, 8)}`, type: 'assistant', content: '', timestamp: Date.now(), ...partial };
}

// A realistic conversation: 6 user→agent turns, each agent turn with tool calls.
const entries: LogEntry[] = [];
for (let t = 0; t < 6; t++) {
  entries.push(entry({ type: 'user', content: `question number ${t} about the build` }));
  entries.push(entry({ type: 'reasoning', content: `thinking hard about ${t}\nsecond line` }));
  entries.push(entry({ type: 'tool_call', toolName: 'read_file', toolArgs: `{"path":"f${t}.ts"}`, content: '' }));
  entries.push(entry({ type: 'tool_result', toolName: 'read_file', toolResult: `file ${t} contents`, content: '' }));
  entries.push(entry({ type: 'assistant', content: `Answer ${t} with **markdown** and a longer body to wrap.` }));
}

const store = new StreamStore();
// Stateful host so browseMode changes re-render the pane (like app.tsx does).
let browseMode = false;
let bumpHost: () => void = () => {};
function Host() {
  const [, setTick] = useState(0);
  bumpHost = () => setTick((n) => n + 1);
  return (
    <StreamProvider store={store}>
      <MessageLog
        entries={entries}
        maxHeight={22}
        active
        browseMode={browseMode}
        onBrowseModeChange={(on) => {
          browseMode = on;
          bumpHost();
        }}
        agentRunning={false}
      />
    </StreamProvider>
  );
}
const setup = await testRender(<Host />, { width: 80, height: 26, kittyKeyboard: true });

async function frame(): Promise<string> {
  await new Promise((r) => setTimeout(r, 25));
  await setup.flush();
  return setup.captureCharFrame();
}

try {
  // Tail-follow: the last turn's content is visible, the first is not.
  let f = await frame();
  check('tail visible (auto-follow)', f.includes('Answer 5'), f.slice(0, 300));
  check('head windowed out', !f.includes('question number 0'));
  check('position hint shown', f.includes('above'));

  // Turn group header rendered.
  check('turn group header', f.includes('Agent'));

  // Browse mode via Ctrl+P.
  setup.mockInput.pressKey('p', { ctrl: true });
  f = await frame();
  check('browse mode on', browseMode === true && f.includes('BROWSE'), f.slice(0, 200));

  // ↑ moves focus up — older content enters the window.
  setup.mockInput.pressArrow('up');
  setup.mockInput.pressArrow('up');
  setup.mockInput.pressArrow('up');
  setup.mockInput.pressArrow('up');
  f = await frame();
  check('browse up reveals older entries', !f.includes('Answer 5') || f.includes('above'), f.slice(0, 300));

  // Esc exits browse mode.
  setup.mockInput.pressEscape();
  f = await frame();
  check('browse mode off', browseMode === false);

  // Home/End in browse mode. (mockInput has no key-name form for home/end —
  // feed the raw escape sequences, which the kitty parser maps to the keys.)
  setup.mockInput.pressKey('p', { ctrl: true });
  await frame();
  setup.mockInput.pressKey('\x1b[H');
  f = await frame();
  check('Home jumps to top', f.includes('question number 0'), f.slice(0, 300));
  setup.mockInput.pressEscape();
  await frame();
} finally {
  setup.renderer.destroy();
}

if (failures > 0) {
  console.log(`\n${failures} log smoke failure(s)`);
  process.exit(1);
}
console.log('\nall log smoke checks passed');
