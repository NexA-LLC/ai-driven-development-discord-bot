import { expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { canShareChannel, readMentionedChannels } from "../src/gateway/channel-context.js";

function source({ requester = true, bot = true, everyone = true, denied = false } = {}) {
  return {
    id: "123", name: "okinawa", type: ChannelType.GuildText,
    guild: { id: "guild", roles: { everyone: { id: "everyone" } } },
    permissionsFor: (subject: string | { id: string }) => ({ has: (bits: bigint) => {
      expect(bits).toBe(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory);
      const id = typeof subject === "string" ? subject : subject.id;
      return id === "user" ? requester : id === "bot" ? bot : everyone;
    } }),
    permissionOverwrites: { cache: { some: (fn: (value: unknown) => boolean) => fn({ deny: { any: () => denied } }) } },
    messages: { fetch: vi.fn().mockResolvedValue(new Map([["1", { id: "1", content: "沖縄の勉強会", createdAt: new Date("2026-09-09T00:00:00Z"), createdTimestamp: 1, attachments: { size: 0 } }]])) },
  };
}
function message(channel = source(), content = "<#123> の内容は？") {
  return { content, guildId: "guild", channelId: "destination", author: { id: "user" }, client: { user: { id: "bot" } }, guild: { members: { fetch: vi.fn().mockResolvedValue({}) }, channels: { fetch: vi.fn().mockResolvedValue(channel) } } };
}
it("reads only explicitly referenced public channels and includes source links", async () => {
  const channel = source();
  const result = await readMentionedChannels(message(channel) as never);
  expect(result?.readable).toBe(true);
  expect(result?.context).toContain("沖縄の勉強会");
  expect(result?.context).toContain("https://discord.com/channels/guild/123/1");
  expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 20 });
});
it.each([{ requester: false }, { bot: false }, { everyone: false }, { denied: true }])("never reads protected source messages: %j", async settings => {
  const channel = source(settings);
  const result = await readMentionedChannels(message(channel) as never);
  expect(result?.readable).toBe(false);
  expect(channel.messages.fetch).not.toHaveBeenCalled();
});
it("allows private history in its original channel with both participants authorized", () => {
  expect(canShareChannel(source({ everyone: false, denied: true }) as never, "123", "user", "bot")).toBe(true);
});
it("does not fetch anything without an explicit channel mention", async () => {
  const input = message(source(), "こんにちは");
  expect(await readMentionedChannels(input as never)).toBeNull();
  expect(input.guild.channels.fetch).not.toHaveBeenCalled();
});
it("does not read cross-guild channels", async () => {
  const channel = source(); channel.guild.id = "other";
  expect((await readMentionedChannels(message(channel) as never))?.readable).toBe(false);
  expect(channel.messages.fetch).not.toHaveBeenCalled();
});
