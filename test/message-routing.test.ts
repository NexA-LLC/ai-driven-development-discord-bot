import { expect, it, vi } from "vitest";
import { conversationContext, shouldAnswer } from "../src/gateway/message-routing.js";

const now = Date.now();
function fixture() {
  const rows = new Map<string, any>();
  const channel = { type: 0, permissionsFor: () => ({ has: () => true }), messages: { fetch: vi.fn(async id => { if (!rows.has(id)) throw new Error("not found"); return rows.get(id); }) } };
  const base = { guildId: "guild", channelId: "channel", client: { user: { id: "su" } }, guild: { members: { fetch: vi.fn() } }, channel, author: { id: "human", bot: false }, createdTimestamp: now, flags: { has: () => false }, content: "x".repeat(1500) };
  for (let i = 0; i < 20; i++) rows.set(String(i), { ...base, id: String(i), reference: { messageId: String(i + 1), guildId: "guild", channelId: "channel" }, author: { id: i % 2 ? "su" : "human", bot: i % 2 === 1 } });
  return { rows, channel, first: rows.get("0") };
}
it("bounds reply ancestry and does not read the channel timeline", async () => {
  const { first, channel } = fixture(); const result = await conversationContext(first, now);
  expect(result.repliedToSu).toBe(true); expect(result.sources.length).toBeLessThanOrEqual(8);
  expect(result.sources.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(5000);
  expect(channel.messages.fetch.mock.calls.every(c => typeof c[0] === "string")).toBe(true);
});
it.each(["guild", "channel", "old", "ephemeral", "bot", "cycle"])("stops at unsafe ancestor: %s", async mode => {
  const { first, rows } = fixture(); const second = rows.get("1");
  if (mode === "guild") second.guildId = "other";
  if (mode === "channel") second.channelId = "other";
  if (mode === "old") second.createdTimestamp = now - 7 * 3600_000;
  if (mode === "ephemeral") second.flags = { has: () => true };
  if (mode === "bot") second.author = { bot: true, id: "another-bot" };
  if (mode === "cycle") second.reference = { messageId: "0" };
  const result = await conversationContext(first, now);
  expect(result.sources.length).toBe(mode === "cycle" ? 2 : 1);
});
it("fails closed for permissions and separately represents unavailable source content", async () => {
  const { first, channel, rows } = fixture();
  channel.permissionsFor = () => ({ has: () => false });
  expect((await conversationContext(first, now)).sources).toEqual([]); expect(channel.messages.fetch).not.toHaveBeenCalled();
  channel.permissionsFor = () => ({ has: () => true }); rows.delete("1");
  expect((await conversationContext(first, now)).status).toBe("unavailable");
  expect(shouldAnswer({ human: true, guildId: "guild", primaryGuildId: "guild", allowedChannel: true, mentioned: false, repliedToSu: false, audioAddressed: false })).toBe(false);
});
