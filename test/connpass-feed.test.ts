import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnpassFeed, CONNPASS_FEED_URL, MAX_FEED_BYTES, parseAtom, eventReference } from "../src/gateway/connpass-feed.js";
import { ExperienceStore } from "../src/gateway/experience-memory.js";
import { deliverMusing } from "../src/gateway/musing.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const now = Date.parse("2026-09-16T00:00:00Z");
const later = now + 3600_000;
const entry = (id: string, published = "2026-09-16T00:01:00Z", urlId = id) => `<entry><id>urn:${id}</id><title>AI駆動開発勉強会 ${id}</title><link href="https://aid.connpass.com/event/${urlId}/?utm_source=atom"/><published>${published}</published><updated>2026-09-16T00:10:00Z</updated><summary type="html">&lt;p&gt;公開情報&lt;/p&gt;&lt;script&gt;bad()&lt;/script&gt;</summary></entry>`;
const atom = (entries = "") => `<feed xmlns="http://www.w3.org/2005/Atom"><title>AI駆動開発</title>${entries}</feed>`;
const response = (xml: string) => new Response(xml, { headers: { "content-type": "application/atom+xml", etag: '"version1"', "last-modified": "Wed, 16 Sep 2026 00:00:00 GMT" } });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "su-feed-test-")); dirs.push(dir);
  const path = join(dir, "feed.json"); return { path, feed: new ConnpassFeed(path), store: new ExperienceStore(join(dir, "memories.json")) };
}
it("parses default/prefixed namespaces, strips HTML, deduplicates id and canonical URL, keeps dates labelled", () => {
  const parsed = parseAtom(atom(entry("1") + entry("1") + entry("2", undefined, "1")), now);
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]).toMatchObject({ url: "https://aid.connpass.com/event/1/", summary: "公開情報", published: "2026-09-16T00:01:00Z" });
  const prefixed = atom(entry("1")).replace(/xmlns=/, "xmlns:a=").replace(/<(\/?)(feed|title|entry|id|link|published|updated|summary)(?=[\s>])/g, "<$1a:$2");
  expect(parseAtom(prefixed).entries).toHaveLength(1);
  expect(eventReference(parsed.entries)).toContain("開催日時ではない");
  expect(parsed.entries[0]).not.toHaveProperty("eventDate");
  expect(parseAtom(atom(entry("1", ""))).entries[0]?.published).toBeNull();
  expect(parseAtom(atom()).entries).toEqual([]);
});
it.each(["<feed>", "<rss/>", '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + atom(), atom("<entry>"), atom("x".repeat(MAX_FEED_BYTES))])("fails closed on malformed, unknown or huge XML", xml => {
  expect(() => parseAtom(xml)).toThrow();
});
it("uses fixed HTTPS URL, conditional requests, preserves cache on 304, and distinguishes failure from empty", async () => {
  const { feed } = setup();
  const fetcher = vi.fn().mockResolvedValueOnce(response(atom(entry("1")))).mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(new Response("bad", { status: 503 })).mockResolvedValueOnce(response(atom()));
  await feed.refresh(fetcher, now); expect(feed.status).toBe("ok"); expect(feed.select(now)).toBeUndefined();
  await feed.refresh(fetcher, later);
  expect(fetcher.mock.calls[1]?.[0]).toBe(CONNPASS_FEED_URL);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ redirect: "error", headers: { "if-none-match": '"version1"', "if-modified-since": "Wed, 16 Sep 2026 00:00:00 GMT" } });
  expect(feed.reference("connpassイベント", later)).toHaveLength(1);
  await feed.refresh(fetcher, later + 3600_000); expect(feed.status).toBe("failed");
  await feed.refresh(fetcher, later + 3600_001); expect(fetcher).toHaveBeenCalledTimes(3);
  await feed.refresh(fetcher, later + 7200_000); expect(feed.status).toBe("empty");
});
it("bounds actual response bytes without relying on Content-Length and rejects 304 without cache", async () => {
  const { feed } = setup();
  await feed.refresh(vi.fn().mockResolvedValue(new Response(null, { status: 304 })), now); expect(feed.status).toBe("failed");
  await feed.refresh(vi.fn().mockResolvedValue(response("x".repeat(MAX_FEED_BYTES + 1))), later); expect(feed.status).toBe("failed");
  expect(feed.reference("イベント", later + 2 * 86400_000)).toEqual([]);
});
it("suppresses first backfill across restart and sends only one new event per day with canonical URL", async () => {
  const { path, feed, store } = setup(); await feed.refresh(vi.fn().mockResolvedValue(response(atom(entry("1")))), now);
  const restarted = new ConnpassFeed(path);
  await restarted.refresh(vi.fn().mockResolvedValue(response(atom(entry("1") + entry("2") + entry("3")))), later);
  const generate = vi.fn(async material => { expect(material).toContain("public_event_reference"); expect(material).not.toContain("private-person"); return "AI開発の工夫、気になります。"; });
  const send = vi.fn(async text => { expect(restarted.delivery("https://aid.connpass.com/event/2/")).toBe("pending"); expect(text).toContain("https://aid.connpass.com/event/2/"); return { id: "discord-receipt" }; });
  await deliverMusing({ background: "private-person", memories: [], feed: restarted, store, generate, send, now: later });
  expect(restarted.delivery("https://aid.connpass.com/event/2/")).toBe("spoken");
  expect(new ConnpassFeed(path).select(later)).toBeUndefined();
  expect(send).toHaveBeenCalledOnce();
});
it.each([true, false])("only definite rejection releases a send reservation (definite=%s)", async definite => {
  const { feed, path, store } = setup(); await feed.refresh(vi.fn().mockResolvedValue(response(atom())), now);
  await feed.refresh(vi.fn().mockResolvedValue(response(atom(entry("2")))), later);
  const options = { background: "", memories: [], feed, store, generate: async () => "気になる問い", send: async () => { throw Object.assign(new Error("send failed"), { status: definite ? 403 : 503 }); }, now: later };
  await expect(deliverMusing(options)).rejects.toThrow("send failed");
  expect(new ConnpassFeed(path).delivery("https://aid.connpass.com/event/2/")).toBe(definite ? "unspoken" : "unknown");
  expect(!!new ConnpassFeed(path).select(later)).toBe(definite);
});
it("generation failures never mark spoken, missing publication dates never become new events", async () => {
  const { feed, store } = setup(); await feed.refresh(vi.fn().mockResolvedValue(response(atom())), now);
  await feed.refresh(vi.fn().mockResolvedValue(response(atom(entry("2") + entry("3", "")))), later);
  await expect(deliverMusing({ background: "", memories: [], feed, store, generate: async () => { throw new Error("LLM failed"); }, send: vi.fn(), now: later })).rejects.toThrow();
  expect(feed.delivery("https://aid.connpass.com/event/2/")).toBe("unspoken");
});
