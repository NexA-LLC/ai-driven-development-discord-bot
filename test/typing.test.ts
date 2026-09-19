import { afterEach, expect, it, vi } from "vitest";
import { startTyping } from "../src/gateway/typing.js";
afterEach(() => vi.useRealTimers());
it("shows typing immediately, refreshes while working, and stops after cleanup", async () => {
  vi.useFakeTimers();
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  const stop = startTyping({ sendTyping });
  expect(sendTyping).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14000);
  expect(sendTyping).toHaveBeenCalledTimes(3);
  stop();
  await vi.advanceTimersByTimeAsync(14000);
  expect(sendTyping).toHaveBeenCalledTimes(3);
});
it("ignores typing failures and avoids overlapping requests", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const sendTyping = vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const stop = startTyping({ sendTyping });
  await vi.advanceTimersByTimeAsync(14000);
  expect(sendTyping).toHaveBeenCalledTimes(1);
  reject(new Error("permission denied"));
  await vi.advanceTimersByTimeAsync(7000);
  expect(sendTyping).toHaveBeenCalledTimes(2);
  stop();
  reject(new Error("network failed"));
  await vi.advanceTimersByTimeAsync(7000);
  expect(sendTyping).toHaveBeenCalledTimes(2);
});
