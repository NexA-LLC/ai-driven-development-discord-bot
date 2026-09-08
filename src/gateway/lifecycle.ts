/** Counts complete operations, including claim, delivery, and acknowledgement. */
export class Lifecycle {
  active = 0;
  draining = false;
  drain(): void { this.draining = true; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}
export const lifecycle = new Lifecycle();
