import { expect, it } from "vitest";
import {
  buildAddressedPrompt,
  shouldAnswerMessage,
  stripBotMention,
} from "../src/gateway/message-routing.js";

const base = {
  mentioned: false,
  repliedToSu: false,
  hasAudio: false,
  inMusings: false,
  inMonitoredChannel: false,
  allowMentionsAnywhere: false,
  inWelcome: false,
};

it("answers a Discord reply to Su in the welcome channel without a mention", () => {
  expect(shouldAnswerMessage({ ...base, repliedToSu: true, inWelcome: true })).toBe(true);
});

it("does not answer a random welcome-channel message that is not a reply or mention", () => {
  expect(shouldAnswerMessage({ ...base, inWelcome: true })).toBe(false);
});

it("does not answer a reply to Su in an unmonitored non-welcome channel", () => {
  expect(shouldAnswerMessage({ ...base, repliedToSu: true })).toBe(false);
});

it("still answers mentions in monitored channels", () => {
  expect(shouldAnswerMessage({ ...base, mentioned: true, inMonitoredChannel: true })).toBe(true);
});

it("answers a mention in the welcome channel", () => {
  expect(shouldAnswerMessage({ ...base, mentioned: true, inWelcome: true })).toBe(true);
});

it("answers a text reply to Su in musings without a mention", () => {
  expect(shouldAnswerMessage({ ...base, repliedToSu: true, inMusings: true })).toBe(true);
});

it("answers audio in musings without a mention", () => {
  expect(shouldAnswerMessage({ ...base, hasAudio: true, inMusings: true })).toBe(true);
});

it("does not answer audio in welcome unless it is a mention or reply to Su", () => {
  expect(shouldAnswerMessage({ ...base, hasAudio: true, inWelcome: true })).toBe(false);
  expect(shouldAnswerMessage({ ...base, hasAudio: true, inWelcome: true, repliedToSu: true })).toBe(true);
});

it("quotes Su's previous line so a welcome reply keeps the clerk scene", () => {
  const prompt = buildAddressedPrompt(
    stripBotMention("おにぎりを温めてください", "bot"),
    "ようこそ、お客さん。温めますか？",
  );
  expect(prompt).toContain("スーの直前の発言:");
  expect(prompt).toContain("ようこそ、お客さん。温めますか？");
  expect(prompt).toContain("お客さんの返事:");
  expect(prompt).toContain("おにぎりを温めてください");
});

it("falls back to the shop-help prompt when the user text is only a mention", () => {
  expect(buildAddressedPrompt(stripBotMention("<@bot>", "bot"))).toBe("この店で何ができますか？");
});
