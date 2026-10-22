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
   * Move the base to just past a packet that was just received. A stale packet,
   * including one from the generation before a wrap, does not move the base
   * backwards or treat the wait for the next generation as a full cycle.
   */
  advanceAfter(mappedValue: number): void {
    const index = this.mappedToIndex(mappedValue);
    if (index < 0) return;
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

  /**
   * The offset from the window base: negative means stale, `receiveWindow` or
   * more too far ahead. An id up to `receiveWindow` behind the base across the
   * last wrap, which reads as a high number, is stale too.
   */
  mappedToIndex(mappedValue: number): number {
    if (this.#isNextGen(mappedValue)) {
      return mappedValue + this.#mod - this.#mappedBaseOffset;
    }
    const index = mappedValue - this.#mappedBaseOffset;
    return this.#isBehindAcrossWrap(index) ? index - this.#mod : index;
  }

  /**
   * Whether an id `index` past the base is really up to `receiveWindow` behind
   * it, in the generation before: the base has wrapped since, so the id reads as
   * nearly a whole generation ahead. Before the first wrap no id lies behind the
   * base across it.
   */
  #isBehindAcrossWrap(index: number): boolean {
    return (
      this.#generation > 0 &&
      index >= this.#receiveWindow &&
      index >= this.#mod - this.#receiveWindow
    );
  }

  /**
   * Whether the id is before the receive window: a packet whose acknowledgement
   * was lost is sent again after the window has moved past it, also when the
   * move wrapped the 16-bit id.
   */
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

  /**
   * The generation the id belongs to: one past the current generation if the id
   * has already wrapped, one before it if the id is just behind the base across
   * the last wrap.
   */
  getGeneration(mappedValue: number): number {
    if (this.#isNextGen(mappedValue)) return this.#generation + 1;
    if (this.#isBehindAcrossWrap(mappedValue - this.#mappedBaseOffset)) return this.#generation - 1;
    return this.#generation;
  }

  reset(): void {
    this.#mappedBaseOffset = 0;
    this.#generation = 0;
  }
}
