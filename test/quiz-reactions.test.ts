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
