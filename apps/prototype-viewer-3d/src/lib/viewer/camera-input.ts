/** A missing keyup cannot retain movement indefinitely after a system dialog. */
export const KEY_LEASE_MS = 600;
export class HeldKeys {
  private readonly held = new Map<string, number>();
  get size(): number {
    return this.held.size;
  }
  has(code: string): boolean {
    return this.held.has(code);
  }
  add(code: string, now = performance.now()): void {
    this.held.set(code, now);
  }
  delete(code: string): void {
    this.held.delete(code);
  }
  clear(): void {
    this.held.clear();
  }
  expire(now: number): void {
    for (const [code, last] of this.held) if (now - last >= KEY_LEASE_MS) this.held.delete(code);
  }
}

/** Blocks/second; zooming out must not turn a missed release into a world-sized jump. */
export function keyboardSpeed(distance: number, caves: boolean): number {
  return Math.min(caves ? 32 : 96, Math.max(24, distance * 1.1));
}
