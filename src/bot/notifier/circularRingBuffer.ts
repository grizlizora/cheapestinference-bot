/**
 * High-performance, zero-allocation FIFO Circular Ring Buffer
 */
export class CircularRingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;
  private capacity: number;
  private mask: number;
  private readonly minCapacity: number;
  private readonly maxCapacity: number;

  constructor(initialCapacityPowerOfTwo = 1024, maxCapacityPowerOfTwo = 65536) {
    this.minCapacity = 1 << Math.ceil(Math.log2(Math.max(16, initialCapacityPowerOfTwo)));
    this.maxCapacity = 1 << Math.ceil(Math.log2(Math.max(this.minCapacity, maxCapacityPowerOfTwo)));
    this.capacity = this.minCapacity;
    this.mask = this.capacity - 1;
    this.buffer = new Array<T | undefined>(this.capacity);
  }

  public push(item: T): boolean {
    if (this.count === this.capacity) {
      if (!this.grow()) {
        // Queue full & at upper memory ceiling -> drop oldest element (load shedding)
        this.pop();
      }
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) & this.mask;
    this.count++;
    return true;
  }

  public unshift(item: T): boolean {
    if (this.count === this.capacity) {
      if (!this.grow()) {
        return false;
      }
    }
    this.head = (this.head - 1 + this.capacity) & this.mask;
    this.buffer[this.head] = item;
    this.count++;
    return true;
  }

  public pop(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined; // Allow GC of referenced payload
    this.head = (this.head + 1) & this.mask;
    this.count--;
    if (this.count === 0 && this.capacity > this.minCapacity) {
      this.shrink();
    }
    return item;
  }

  public peek(): T | undefined {
    return this.count === 0 ? undefined : this.buffer[this.head];
  }

  public size(): number {
    return this.count;
  }

  public isEmpty(): boolean {
    return this.count === 0;
  }

  public clear(): void {
    this.capacity = this.minCapacity;
    this.mask = this.capacity - 1;
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  private grow(): boolean {
    if (this.capacity >= this.maxCapacity) {
      return false; // Upper bound reached
    }
    const oldCapacity = this.capacity;
    const oldBuffer = this.buffer;
    this.capacity = oldCapacity << 1;
    this.mask = this.capacity - 1;
    this.buffer = new Array<T | undefined>(this.capacity);

    for (let i = 0; i < this.count; i++) {
      this.buffer[i] = oldBuffer[(this.head + i) & (oldCapacity - 1)];
    }
    this.head = 0;
    this.tail = this.count;
    return true;
  }

  private shrink(): void {
    this.capacity = this.minCapacity;
    this.mask = this.capacity - 1;
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
