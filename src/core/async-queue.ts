/**
 * A minimal async FIFO. Adapters need it because two independent producers feed one event
 * stream: the harness's stdout, and out-of-band callbacks (such as an approval hook's HTTP
 * request). `for await` over one of them blocks the other, so both push into a queue and the
 * event generator drains it.
 */
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Array<(value: T | null) => void> = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  /** No further items will arrive; pending and future readers get null once drained. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  /** Next item, or null once the queue is closed and drained. */
  shift(): Promise<T | null> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.#closed) return Promise.resolve(null);
    return new Promise<T | null>(resolve => this.#waiters.push(resolve));
  }
}
