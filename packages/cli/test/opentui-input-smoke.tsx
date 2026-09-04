/**
 * Headless interactive smoke test for the ported input layer (Phase 3).
 * Run: cd packages/cli && bun test/opentui-input-smoke.tsx
 */
import { testRender } from '@opentui/react/test-utils';
import InputBox from '../src/tui/components/InputBox.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`✓ ${name}`);
  else {
    failures++;
    console.log(`✗ ${name} ${extra}`);
  }
}

const submitted: string[] = [];
let draftLines = -1;
const setup = await testRender(
  <InputBox
    mode="agent"
    agentState="idle"
    onSubmit={(t) => submitted.push(t)}
    onDraftLinesChange={(n) => (draftLines = n)}
    fileIndex={['src/index.ts', 'src/app.tsx', 'README.md']}
  />,
  { width: 80, height: 24, kittyKeyboard: true },
);

async function frame(): Promise<string> {
  // mockInput bursts are synchronous; React commits from raw useKeyboard
  // listeners land in a scheduler macrotask, which flush() alone skips
  // (real terminals have natural gaps between keystrokes). Yield first.
  await new Promise((r) => setTimeout(r, 25));
  await setup.flush();
  return setup.captureCharFrame();
}

try {
  // --- typing + submit ---
  await setup.mockInput.typeText('hello world');
  await frame();
  check('typed text visible', (await frame()).includes('hello world'));

  setup.mockInput.pressEnter();
  await frame();
  check('enter submits', submitted.length === 1 && submitted[0] === 'hello world', JSON.stringify(submitted));
  check('input cleared after submit', !(await frame()).includes('hello world'));

  // --- Shift+Enter inserts newline (kitty) ---
  await setup.mockInput.typeText('line one');
  setup.mockInput.pressEnter({ shift: true });
  await setup.mockInput.typeText('line two');
  await frame();
  const f = await frame();
  check('shift+enter keeps draft (no submit)', submitted.length === 1, JSON.stringify(submitted));
  check('multi-line draft rendered', f.includes('line one') && f.includes('line two'));
  check('draft line count reported', draftLines === 2, `draftLines=${draftLines}`);

  setup.mockInput.pressEnter();
  await frame();
  check('multi-line draft submits as one message', submitted[1] === 'line one\nline two', JSON.stringify(submitted));

  // --- history recall with ↑ ---
  await setup.mockInput.typeText('abc');
  setup.mockInput.pressEnter();
  await frame();
  setup.mockInput.pressArrow('up');
  await frame();
  check('history recall via ↑', (await frame()).includes('abc'));
  setup.mockInput.pressEnter();
  await frame();

  // --- slash picker ---
  await setup.mockInput.typeText('/mo');
  await frame();
  const slashFrame = await frame();
  check('slash picker opens', slashFrame.includes('Commands'), slashFrame.slice(0, 400));
  setup.mockInput.pressEscape();
  await frame();
  // Submit the leftover partial command so the draft is clean for the next
  // section (a draft starting with '/' keeps the slash mode active).
  setup.mockInput.pressEnter();
  await frame();

  // --- @file mention picker ---
  await setup.mockInput.typeText('see @inde');
  await frame();
  const mentionFrame = await frame();
  check('mention picker opens', mentionFrame.includes('Mention file'), mentionFrame.slice(0, 400));
  setup.mockInput.pressEscape();
  await frame();

  // --- paste chip ---
  setup.mockInput.pasteBracketedText('pasted line 1\npasted line 2');
  await frame();
  const pasteFrame = await frame();
  check('paste collapsed to chip', pasteFrame.includes('pasted'), pasteFrame.slice(0, 400));
  check('paste raw text not inline-duplicated', !pasteFrame.includes('pasted line 2'));
  setup.mockInput.pressEnter();
  await frame();
  check('paste chip expands on submit', submitted[submitted.length - 1].includes('pasted line 1\npasted line 2'), JSON.stringify(submitted.slice(-1)));
} finally {
  setup.renderer.destroy();
}

if (failures > 0) {
  console.log(`\n${failures} input smoke failure(s)`);
  process.exit(1);
}
console.log('\nall input smoke checks passed');
