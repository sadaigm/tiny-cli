import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../src/tui/utils/messageQueue.js';

/**
 * Unit tests for the FIFO MessageQueue.
 *
 * This queue is the backbone of the "type while the agent is working"
 * feature: when the user submits a prompt mid-turn, it is enqueued here
 * and drained in order after each turn completes. These tests pin down
 * its contract so the queuing behaviour cannot silently regress.
 */
describe('MessageQueue', () => {
  it('processes messages in FIFO order (the core requirement)', () => {
    const q = new MessageQueue();
    q.enqueue('first');
    q.enqueue('second');
    q.enqueue('third');

    expect(q.dequeue()).toBe('first');
    expect(q.dequeue()).toBe('second');
    expect(q.dequeue()).toBe('third');
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
    expect(q.dequeue()).toBe('hello world');
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
    expect(q.peek()).toBe('first');
    // peek does not mutate.
    expect(q.peek()).toBe('first');
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

  it('toArray() returns a shallow copy in order and does not mutate the queue', () => {
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

  it('simulates a full drain cycle as useAgent performs it', () => {
    // Mirror the real usage in useAgent.runAgentTurn():
    //   const next = queue.dequeue();
    //   if (next) { runTurn(next); ... }
    const q = new MessageQueue();
    q.enqueue('queued-while-busy-1');
    q.enqueue('queued-while-busy-2');

    const drained: string[] = [];
    let next = q.dequeue();
    while (next !== null) {
      drained.push(next);
      next = q.dequeue();
    }

    expect(drained).toEqual(['queued-while-busy-1', 'queued-while-busy-2']);
    expect(q.isEmpty).toBe(true);
  });
});
