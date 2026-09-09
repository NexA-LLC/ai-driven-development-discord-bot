import { expect, it } from "vitest";
import { buildQuizPrompt, isQuizPrompt, parseQuiz, renderQuiz } from "../src/shared/quiz.js";

it("keeps a supplied opinion question and uses the shared daily poll format", () => {
  const question = "カニとエビはどっちが美味しい？";
  const prompt = buildQuizPrompt(question);
  expect(isQuizPrompt(prompt)).toBe(true);
  expect(prompt).toContain(question);
  const output = renderQuiz(parseQuiz(JSON.stringify({ type: "opinion", question, choices: ["カニ", "エビ", "どちらも同じくらい", "どちらも好みではない"], answer: "カニ", explanation: "hidden answer" })));
  expect(output).toContain(question);
  expect(output).toContain("1️⃣ カニ");
  expect(output).toContain("リアクション");
  expect(output).not.toContain("hidden answer");
  expect(output).not.toContain("||");
});

it("rejects invalid choices instead of showing raw model output", () => {
  expect(() => parseQuiz('{"question":"test","choices":["a","a","b","c"]}')).toThrow();
  expect(() => parseQuiz("answer: Python for loop")).toThrow();
});

it("uses the same semantic emoji set for choices and reactions", async () => {
  const { quizEmojis } = await import("../src/shared/quiz.js");
  const quiz = parseQuiz(JSON.stringify({ question: "増加する？", choices: ["倍増", "増加", "横ばい", "減少"], emojis: ["🚀", "📈", "➡️", "📉"] }));
  expect(quizEmojis(quiz)).toEqual(["🚀", "📈", "➡️", "📉"]);
  quizEmojis(quiz).forEach((emoji, i) => expect(renderQuiz(quiz)).toContain(`${emoji} ${quiz.choices[i]}`));
});

it.each([undefined, ["🚀", "🚀", "➡️", "📉"], ["🚀"], ["🚀", "📈", "text", "📉"], ["🚀", "📈", "<:custom:123>", "📉"]])("falls back as a whole when emoji output is unusable: %j", async (emojis) => {
  const { quizEmojis } = await import("../src/shared/quiz.js");
  const quiz = parseQuiz(JSON.stringify({ question: "test", choices: ["a", "b", "c", "d"], emojis }));
  expect(quizEmojis(quiz)).toEqual(["1️⃣", "2️⃣", "3️⃣", "4️⃣"]);
  expect(renderQuiz(quiz)).toContain("1️⃣ a");
});
