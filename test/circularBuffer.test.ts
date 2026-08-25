import { describe, it, expect } from "vitest";
import { CircularRingBuffer } from "../src/bot/notifier/circularRingBuffer.js";

describe("CircularRingBuffer", () => {
  it("should push and pop items in FIFO order", () => {
    const ring = new CircularRingBuffer<string>(4);
    expect(ring.isEmpty()).toBe(true);

    ring.push("item1");
    ring.push("item2");
    ring.push("item3");

    expect(ring.size()).toBe(3);
    expect(ring.pop()).toBe("item1");
    expect(ring.pop()).toBe("item2");
    expect(ring.pop()).toBe("item3");
    expect(ring.pop()).toBeUndefined();
    expect(ring.isEmpty()).toBe(true);
  });

  it("should support unshift (push to front) for P1 rate-limit retries", () => {
    const ring = new CircularRingBuffer<number>(4);
    ring.push(10);
    ring.push(20);
    ring.unshift(5);

    expect(ring.pop()).toBe(5);
    expect(ring.pop()).toBe(10);
    expect(ring.pop()).toBe(20);
  });

  it("should automatically grow capacity when buffer is full", () => {
    const ring = new CircularRingBuffer<number>(2);
    for (let i = 0; i < 100; i++) {
      ring.push(i);
    }

    expect(ring.size()).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(ring.pop()).toBe(i);
    }
    expect(ring.isEmpty()).toBe(true);
  });
});
