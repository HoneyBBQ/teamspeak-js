export class GenerationWindow {
  #mappedBaseOffset = 0;
  #generation = 0;
  readonly #mod: number;
  readonly #receiveWindow: number;

  constructor(mod: number, windowSize: number) {
    this.#mod = mod;
    this.#receiveWindow = windowSize;
  }

  get generation(): number {
    return this.#generation;
  }

  advance(amount: number): void {
    if (amount <= 0) return;
    const newBaseOffset = this.#mappedBaseOffset + amount;
    const genStep = Math.floor(newBaseOffset / this.#mod);
    if (genStep > 0) {
      this.#generation = Math.min(this.#generation + genStep, 0xffff_ffff);
    }
    this.#mappedBaseOffset = newBaseOffset % this.#mod;
  }

  advanceToExcluded(mappedValue: number): void {
    let moveDist = mappedValue - this.#mappedBaseOffset;
    if (moveDist < 0) moveDist += this.#mod;
    this.advance(moveDist + 1);
  }

  /**
   * Move the base just past a packet received on a stream that is never sent
   * again. A stale packet leaves the base where it is: one before the base, or
   * one that reads as far ahead but is from before the last wrap, which only a
   * window that has wrapped can have.
   */
  advanceAfter(mappedValue: number): void {
    const index = this.mappedToIndex(mappedValue);
    if (index < 0) return;
    if (this.#generation > 0 && index >= this.#mod - this.#receiveWindow) return;
    this.advance(index + 1);
  }

  syncTo(mappedValue: number): void {
    let moveDist = mappedValue - this.#mappedBaseOffset;
    if (moveDist < 0) moveDist += this.#mod;
    this.advance(moveDist);
  }

  isInWindow(mappedValue: number): boolean {
    const maxOffset = this.#mappedBaseOffset + this.#receiveWindow;
    if (maxOffset < this.#mod) {
      return mappedValue >= this.#mappedBaseOffset && mappedValue < maxOffset;
    }
    return mappedValue >= this.#mappedBaseOffset || mappedValue < maxOffset - this.#mod;
  }

  mappedToIndex(mappedValue: number): number {
    if (this.#isNextGen(mappedValue)) {
      return mappedValue + this.#mod - this.#mappedBaseOffset;
    }
    return mappedValue - this.#mappedBaseOffset;
  }

  isOldPacket(mappedValue: number): boolean {
    return this.mappedToIndex(mappedValue) < 0;
  }

  isFuturePacket(mappedValue: number): boolean {
    return this.mappedToIndex(mappedValue) >= this.#receiveWindow;
  }

  #isNextGen(mappedValue: number): boolean {
    return (
      this.#mappedBaseOffset > this.#mod - this.#receiveWindow &&
      mappedValue < this.#mappedBaseOffset + this.#receiveWindow - this.#mod
    );
  }

  getGeneration(mappedValue: number): number {
    if (this.#isNextGen(mappedValue)) return this.#generation + 1;
    return this.#generation;
  }

  reset(): void {
    this.#mappedBaseOffset = 0;
    this.#generation = 0;
  }
}
