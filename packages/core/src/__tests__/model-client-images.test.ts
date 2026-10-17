// model/client.ts imports node-fetch (ESM-only) — stub it so the CommonJS
// test transform doesn't choke on the import.
jest.mock('node-fetch', () => ({ default: jest.fn() }));

import { ModelClient } from '../model/client.js';
import { Message } from '../types.js';

/**
 * Wire-format tests for image attachments (design:
 * image_processing-design.md §2.3). `toApiMessages` is the single
 * payload-transform shared by the buffered, streamed, and generator paths.
 */
describe('ModelClient image payload transform', () => {
  const client = new ModelClient({ endpoint: 'http://localhost:1/v1', model: 'test' });
  // Payload building is a pure private helper — reach it directly rather
  // than standing up a mock /chat/completions server.
  const toApiMessages = (messages: Message[]): any[] =>
    (client as any).toApiMessages(messages);

  it('keeps text-only user messages as plain string content', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    const api = toApiMessages(messages);
    expect(api[0]).toBe(messages[0]); // passed through untouched
    expect(api[0].content).toBe('hello');
  });

  it('turns a user message with images into a content-parts array', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'what is this?',
        images: [
          { path: 'a.png', mimeType: 'image/png', data: 'QUJD' },
          { path: 'b.jpg', mimeType: 'image/jpeg', data: 'REVG' },
        ],
      },
    ];
    const api = toApiMessages(messages);

    expect(api[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,REVG' } },
    ]);
    // The attachments stay on the message object itself (not extra keys
    // leaking onto the wire beyond content).
    expect(api[0].images).toBeUndefined();
  });

  it('ignores attachments without data (persisted, not yet re-read)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'replayed',
        images: [{ path: 'gone.png', mimeType: 'image/png' }],
      },
    ];
    const api = toApiMessages(messages);
    expect(api[0].content).toBe('replayed'); // stays a plain string
  });

  it('never transforms non-user roles', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hi', images: [{ path: 'a.png', mimeType: 'image/png', data: 'QUJD' }] } as Message,
    ];
    const api = toApiMessages(messages);
    expect(api[0]).toBe(messages[0]);
    expect(typeof api[0].content).toBe('string');
  });
});
