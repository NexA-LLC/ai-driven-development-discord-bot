import { expect, it, vi } from "vitest";
import { parseQuiz, renderQuiz } from "../src/shared/quiz.js";
import { renderedQuizEmojis, seedQuizReactions } from "../src/shared/quiz-reactions.js";

it.each([undefined, ["🚀", "📈", "➡️", "📉"]])("seeds all four rendered answer reactions: %j", async emojis => {
  const content = renderQuiz(parseQuiz(JSON.stringify({ question: "どうなる？", choices: ["倍増", "増加", "横ばい", "減少"], emojis })));
  const expected = emojis ?? ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
  expect(renderedQuizEmojis(content)).toEqual(expected);
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await seedQuizReactions(content, { id: "message", channel_id: "channel" }, "test-token");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expected.forEach((emoji, i) => expect(fetcher.mock.calls[i]?.[0]).toContain(`/reactions/${encodeURIComponent(emoji)}/@me`));
  } finally { vi.unstubAllGlobals(); }
});
it("does not add reactions to normal replies", () => expect(renderedQuizEmojis("こんにちは")).toEqual([]));
it("honors rate limits and retries only the failed reaction", async () => {
  const content = renderQuiz(parseQuiz(JSON.stringify({ question: "どう？", choices: ["a", "b", "c", "d"] })));
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }));
  const wait = vi.fn(async () => {});
  vi.stubGlobal("fetch", fetcher);
  try {
    await seedQuizReactions(content, { id: "m", channel_id: "c" }, "token", wait);
    expect(wait).toHaveBeenCalledWith(2100);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  } finally { vi.unstubAllGlobals(); }
});
it("bounds retries and still attempts every choice after a failure", async () => {
  const content = renderQuiz(parseQuiz(JSON.stringify({ question: "どう？", choices: ["a", "b", "c", "d"] })));
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(seedQuizReactions(content, { id: "m", channel_id: "c" }, "token", async () => {})).rejects.toThrow("incomplete");
    expect(fetcher).toHaveBeenCalledTimes(16);
  } finally { vi.unstubAllGlobals(); }
});
