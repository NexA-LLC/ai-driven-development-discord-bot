import { expect, it, vi } from "vitest";
import { ChannelType, type Message } from "discord.js";
import { postChannelMessage } from "../src/gateway/channel-post.js";
function fixture(permitted = true) {
  const send = vi.fn().mockResolvedValue({ id: "sent", url: "https://discord.com/channels/g/123/sent" });
  const channel = { type: ChannelType.GuildText, guild: { id: "g" }, permissionsFor: vi.fn(() => ({ has: () => permitted })), send };
  const message = { id: "request", content: "<#123> に挨拶して", guildId: "g", author: { id: "requester" }, client: { user: { id: "bot" } }, guild: { members: { fetch: vi.fn() }, channels: { fetch: vi.fn().mockResolvedValue(channel) } } } as unknown as Message;
  return { message, send };
}
it("sends once with notifications suppressed and a stable nonce, and returns the actual URL", async () => {
  const { message, send } = fixture();
  expect(await postChannelMessage(message, { channel_id: "123", content: "はいさい！" })).toMatchObject({ posted: true, messageId: "sent" });
  expect(send).toHaveBeenCalledWith({ content: "はいさい！", allowedMentions: { parse: [] }, nonce: "request", enforceNonce: true });
});
it("rejects an unmentioned destination before sending", async () => {
  const { message, send } = fixture();
  await expect(postChannelMessage(message, { channel_id: "456", content: "hello" })).rejects.toThrow("指定");
  expect(send).not.toHaveBeenCalled();
});
it("rejects missing requester or bot permissions", async () => {
  const { message, send } = fixture(false);
  await expect(postChannelMessage(message, { channel_id: "123", content: "hello" })).rejects.toThrow("権限");
  expect(send).not.toHaveBeenCalled();
});
