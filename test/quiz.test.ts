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
