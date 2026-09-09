import { expect, it, vi } from "vitest";
import { runMentionAgent, type AgentMessage } from "../src/gateway/mention-agent.js";

it("lets the model decide whether to read, then returns the tool result to the model", async () => {
  const complete = vi.fn()
    .mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [{ id: "read1", type: "function", function: { name: "read_channel_history", arguments: '{"channel_id":"123"}' } }] })
    .mockImplementationOnce(async (messages: AgentMessage[]) => {
      expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "read1" });
      expect(messages.at(-1)?.content).toContain("本文を取得できない");
      return { role: "assistant", content: "チャンネルは見えますが、本文を取得できない状態です。" };
    });
  const execute = vi.fn().mockResolvedValue({ status: "1件あるが本文を取得できない" });
  const result = await runMentionAgent("<#123> は見える？", "persona", complete, execute);
  expect(execute).toHaveBeenCalledWith("read_channel_history", { channel_id: "123" });
  expect(result).toContain("チャンネルは見えます");
});
it("does not force a history read merely because a channel is mentioned", async () => {
  const complete = vi.fn().mockResolvedValue({ role: "assistant", content: "投稿機能は未接続ですが、沖縄らしい挨拶案を作ります。" });
  const execute = vi.fn();
  const question = "<#123> に挨拶投稿できる? 沖縄っぽく";
  expect(await runMentionAgent(question, "persona", complete, execute)).toContain("挨拶案");
  expect(execute).not.toHaveBeenCalled();
  expect(complete.mock.calls[0]?.[0][1]).toEqual({ role: "user", content: question });
});
it("returns unsupported tool errors to the model without executing them", async () => {
  const complete = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "delete_channel", arguments: "{}" } }] }).mockResolvedValueOnce({ role: "assistant", content: "投稿はしていません。" });
  const execute = vi.fn();
  await runMentionAgent("投稿して", "persona", complete, execute);
  expect(execute).not.toHaveBeenCalled();
  expect(complete.mock.calls[1]?.[0].at(-1).content).toContain("not available");
});
it("executes a model-selected post once and returns its receipt to the model", async () => {
  const call = { role: "assistant", content: null, tool_calls: [{ id: "p", type: "function", function: { name: "post_channel_message", arguments: '{"channel_id":"123","content":"はいさい"}' } }] };
  const complete = vi.fn().mockResolvedValueOnce(call).mockResolvedValueOnce(call).mockResolvedValueOnce({ role: "assistant", content: "投稿しました。" });
  const execute = vi.fn().mockResolvedValue({ posted: true, url: "https://discord.com/channels/g/123/m" });
  await runMentionAgent("<#123> に挨拶して", "persona", complete, execute);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith("post_channel_message", { channel_id: "123", content: "はいさい" });
});
it("lets the model select the cosmetic reaction and sees the result before answering", async () => {
  const complete = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "show_lethwei_reaction", arguments: "{}" } }] }).mockResolvedValueOnce({ role: "assistant", content: "その発言はやめてください💢" });
  const execute = vi.fn().mockResolvedValue({ attachedToReply: true, realAction: false });
  await runMentionAgent("不適切な発言", "persona", complete, execute);
  expect(execute).toHaveBeenCalledWith("show_lethwei_reaction", {});
});
it("allows the model to prepare an audio reply", async () => {
  const complete = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [{ id: "voice", type: "function", function: { name: "speak_reply", arguments: '{"text":"こんにちは。スーです。"}' } }] }).mockResolvedValueOnce({ role: "assistant", content: "こんにちは。スーです。" });
  const execute = vi.fn().mockResolvedValue({ prepared: true });
  await runMentionAgent("声で挨拶して", "persona", complete, execute);
  expect(execute).toHaveBeenCalledWith("speak_reply", { text: "こんにちは。スーです。" });
});
it("routes a voice-channel invitation through the model-selected join tool", async () => {
  const complete = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [{ id: "join", type: "function", function: { name: "join_voice_channel", arguments: "{}" } }] }).mockResolvedValueOnce({ role: "assistant", content: "参加しました。" });
  const execute = vi.fn().mockResolvedValue({ joined: true });
  await runMentionAgent("今いるボイスチャンネルに来て", "persona", complete, execute);
  expect(execute).toHaveBeenCalledWith("join_voice_channel", {});
});
