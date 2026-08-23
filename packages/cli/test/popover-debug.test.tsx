import React from 'react';
import { describe, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import AutocompletePopover from '../src/tui/components/AutocompletePopover.js';

const MENTION_POPOVER_ROWS = 16;

describe('DEBUG popover rows', () => {
  it('renders all rows bare', () => {
    const items = Array.from({ length: 25 }, (_, n) => `file_${n + 1}`);
    const { lastFrame } = render(
      <AutocompletePopover
        items={items}
        title="Mention file (@tu)"
        maxVisible={MENTION_POPOVER_ROWS - 5}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    console.log('--- bare (selection at 0) ---\n' + lastFrame());
  });

  it('renders scrolled window with highlight in the middle', () => {
    const items = Array.from({ length: 25 }, (_, n) => `file_${n + 1}`);
    const { lastFrame } = render(
      <Box height={MENTION_POPOVER_ROWS} flexDirection="column">
        <AutocompletePopover
          items={items}
          title="Mention file (@tu)"
          maxVisible={MENTION_POPOVER_ROWS - 5}
          selectedIndex={7}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      </Box>,
    );
    console.log('--- scrolled (selection at 7) ---\n' + lastFrame());
  });
});
