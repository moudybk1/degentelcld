/**
 * Injected application clock (blueprint §5.4). Domain code never calls
 * Date.now() directly; live uses the system clock, tests and replay use a
 * virtual clock.
 */
export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    if (ms < this.current) throw new Error("Virtual clock cannot move backwards");
    this.current = ms;
  }
  advance(ms: number): void {
    this.set(this.current + ms);
  }
}
