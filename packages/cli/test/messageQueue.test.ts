import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../src/tui/utils/messageQueue.js';
import type { ImageAttachment } from '@tiny-cli/core';

/**
 * Unit tests for the FIFO MessageQueue.
 *
 * This queue is the backbone of the "type while the agent is working"
 * feature: when the user submits a prompt mid-turn, it is enqueued here
 * and drained in order after each agent turn completes. These tests pin
 * down its contract so the queuing behaviour cannot silently regress.
 */
describe('MessageQueue', () => {
  it('processes messages in FIFO order (the core requirement)', () => {
    const q = new MessageQueue();
    q.enqueue('first');
    q.enqueue('second');
    q.enqueue('third');

    expect(q.dequeue()).toEqual({ text: 'first' });
    expect(q.dequeue()).toEqual({ text: 'second' });
    expect(q.dequeue()).toEqual({ text: 'third' });
    // After draining everything, the queue is empty.
    expect(q.dequeue()).toBeNull();
  });

  it('rejects empty and whitespace-only messages on enqueue', () => {
    const q = new MessageQueue();
    expect(q.enqueue('')).toBe(false);
    expect(q.enqueue('   ')).toBe(false);
    expect(q.enqueue('\t\n')).toBe(false);
    expect(q.length).toBe(0);
    expect(q.isEmpty).toBe(true);
  });

  it('trims surrounding whitespace when enqueuing', () => {
    const q = new MessageQueue();
    q.enqueue('  hello world  ');
    expect(q.dequeue()).toEqual({ text: 'hello world' });
  });

  it('carries image attachments through the queue with their text', () => {
    const q = new MessageQueue();
    const images: ImageAttachment[] = [
      { path: 'a.png', mimeType: 'image/png', data: 'AAAA' },
    ];
    q.enqueue('look at this', images);
    q.enqueue('text only');

    expect(q.dequeue()).toEqual({ text: 'look at this', images });
    expect(q.dequeue()).toEqual({ text: 'text only' });
  });

  it('omits the images field when enqueueing without attachments', () => {
    const q = new MessageQueue();
    q.enqueue('plain');
    // No empty `images: []` key — queued items stay plain messages.
    expect(q.dequeue()).toEqual({ text: 'plain' });
  });

  it('reports correct length and isEmpty state', () => {
    const q = new MessageQueue();
    expect(q.isEmpty).toBe(true);
    expect(q.length).toBe(0);

    q.enqueue('a');
    q.enqueue('b');
    expect(q.isEmpty).toBe(false);
    expect(q.length).toBe(2);

    q.dequeue();
    expect(q.length).toBe(1);
    q.dequeue();
    expect(q.isEmpty).toBe(true);
  });

  it('peek() returns the front without removing it', () => {
    const q = new MessageQueue();
    expect(q.peek()).toBeNull();

    q.enqueue('first');
    q.enqueue('second');
    expect(q.peek()).toEqual({ text: 'first' });
    // peek does not mutate.
    expect(q.peek()).toEqual({ text: 'first' });
    expect(q.length).toBe(2);
  });

  it('dequeue() on an empty queue returns null', () => {
    const q = new MessageQueue();
    expect(q.dequeue()).toBeNull();
  });

  it('clear() empties the queue', () => {
    const q = new MessageQueue();
    q.enqueue('a');
    q.enqueue('b');
    q.clear();
    expect(q.length).toBe(0);
    expect(q.isEmpty).toBe(true);
    expect(q.peek()).toBeNull();
  });

  it('toArray() returns the message texts in order and does not mutate the queue', () => {
    const q = new MessageQueue();
    q.enqueue('one');
    q.enqueue('two');
    q.enqueue('three');

    const snapshot = q.toArray();
    expect(snapshot).toEqual(['one', 'two', 'three']);
    // The underlying queue is untouched.
    expect(q.length).toBe(3);
    // Mutating the snapshot must not affect the queue.
    snapshot.push('injected');
    expect(q.toArray()).toEqual(['one', 'two', 'three']);
  });

  it('simulates a full drain cycle as runTurn performs it', () => {
    // Mirror the real usage in runAgentTurn():
    //   const next = queue.dequeue();
    //   if (next) { runTurn(next.text, next.images); ... }
    const q = new MessageQueue();
    q.enqueue('queued-while-busy-1');
    q.enqueue('queued-while-busy-2');

    const drained: string[] = [];
    let next = q.dequeue();
    while (next !== null) {
      drained.push(next.text);
      next = q.dequeue();
    }

    expect(drained).toEqual(['queued-while-busy-1', 'queued-while-busy-2']);
    expect(q.isEmpty).toBe(true);
  });
});
