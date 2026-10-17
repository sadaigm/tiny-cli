/**
 * Message queue for messages submitted while the agent is busy.
 *
 * When the user presses Enter while the agent is mid-turn, the message
 * is enqueued instead of being sent immediately. After each agent turn
 * completes, `dequeue()` is called to drain the next queued message,
 * which is then processed as a new turn.
 *
 * This module provides a small FIFO queue class plus convenience exports
 * for callers that prefer function-style usage.
 */
import type { ImageAttachment } from '@tiny-cli/core';

/** A queued user message: hydrated text plus any @mentioned images. */
export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
}

/**
 * A simple FIFO queue for user messages.
 *
 * Messages are processed in the order they were submitted.
 * Empty strings and whitespace-only strings are rejected on enqueue.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];

  /** Current number of queued messages. */
  get length(): number {
    return this.items.length;
  }

  /** Whether the queue is empty. */
  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Add a message to the back of the queue.
   *
   * @param message - The user message text to enqueue.
   * @param images - Image attachments hydrating the message, if any.
   * @returns `true` if the message was enqueued, `false` if it was empty/whitespace and rejected.
   */
  enqueue(message: string, images?: ImageAttachment[]): boolean {
    const trimmed = message.trim();
    if (!trimmed) return false;
    this.items.push({ text: trimmed, ...(images && images.length > 0 ? { images } : {}) });
    return true;
  }

  /**
   * Remove and return the message at the front of the queue.
   *
   * @returns The next message, or `null` if the queue is empty.
   */
  dequeue(): QueuedMessage | null {
    if (this.items.length === 0) return null;
    return this.items.shift() ?? null;
  }

  /**
   * Return the message at the front of the queue without removing it.
   *
   * @returns The next message, or `null` if the queue is empty.
   */
  peek(): QueuedMessage | null {
    if (this.items.length === 0) return null;
    return this.items[0] ?? null;
  }

  /** Remove all messages from the queue. */
  clear(): void {
    this.items = [];
  }

  /** Message texts in queue order (for display/debugging). */
  toArray(): string[] {
    return this.items.map((item) => item.text);
  }
}
