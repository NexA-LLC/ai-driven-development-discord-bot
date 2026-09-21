import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnpassFeed, CONNPASS_API_URL, MAX_API_BYTES, parseConnpassEvents, eventReference } from "../src/gateway/connpass-feed.js";
import { ExperienceStore } from "../src/gateway/experience-memory.js";
import { deliverMusing } from "../src/gateway/musing.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = Date.parse("2026-09-16T00:00:00Z");
const later = now + 3600_000;
const event = (id: number, updatedAt: string | null = "2026-09-16T00:01:00Z") => ({
  event_id: id,
  title: `AI駆動開発勉強会 ${id}`,
  catch: "公開情報",
  description: "<p>APIの説明</p><script>bad()</script>",
  event_url: `https://aid.connpass.com/event/${id}/?utm_source=api`,
  started_at: "2026-09-20T19:00:00+09:00",
  ended_at: "2026-09-20T21:00:00+09:00",
  updated_at: updatedAt,
});
const currentV2Event = (id: number, updatedAt: string | null = "2026-09-16T00:01:00Z") => {
  const { event_id, event_url, ...rest } = event(id, updatedAt);
  return { ...rest, id: event_id, url: event_url };
};
const api = (events: ReturnType<typeof event>[] = []) => JSON.stringify({
  results_start: 1,
  results_returned: events.length,
  results_available: events.length,
  events,
});
const response = (body: string) => new Response(body, { headers: {
  "content-type": "application/json; charset=utf-8",
  etag: '"version1"',
  "last-modified": "Wed, 16 Sep 2026 00:00:00 GMT",
} });
function setup(apiKey = "test-api-key") {
  const dir = mkdtempSync(join(tmpdir(), "su-feed-test-")); dirs.push(dir);
  const path = join(dir, "feed.json");
  return { path, feed: new ConnpassFeed(path, undefined, undefined, undefined, apiKey), store: new ExperienceStore(join(dir, "memories.json")) };
}

it("parses API v2 events, strips HTML, deduplicates, and keeps actual event dates labelled", () => {
  const parsed = parseConnpassEvents(api([event(1), event(1)]), now);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({
    id: "1",
    url: "https://aid.connpass.com/event/1/",
    summary: "公開情報 APIの説明",
    startedAt: "2026-09-20T19:00:00+09:00",
    endedAt: "2026-09-20T21:00:00+09:00",
    updatedAt: "2026-09-16T00:01:00Z",
  });
  expect(eventReference(parsed)).toContain("startedAt/endedAtは開催日時");
  expect(eventReference(parsed)).toContain('"startedAt":"2026-09-20T19:00:00+09:00"');
  expect(parseConnpassEvents(api([event(2, null)]))[0]?.updatedAt).toBeNull();
  expect(parseConnpassEvents(api())).toEqual([]);
});

it("accepts the current connpass API v2 id and url field names", () => {
  const liveShape = currentV2Event(407072);
  const parsed = parseConnpassEvents(JSON.stringify({
    results_start: 1,
    results_returned: 1,
    results_available: 1,
    events: [liveShape],
  }), now);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ id: "407072", url: "https://aid.connpass.com/event/407072/" });
});

it.each([
  "{",
  "[]",
  JSON.stringify({ results_start: 1, results_returned: 1, results_available: 1, events: [] }),
  JSON.stringify({ results_start: 1, results_returned: 1, results_available: 1, events: [{ ...event(1), event_url: "https://evil.example/event/1/" }] }),
  JSON.stringify({ results_start: 1, results_returned: 1, results_available: 1, events: [{ ...event(1), event_url: "https://aid.connpass.com/event/2/" }] }),
  "x".repeat(MAX_API_BYTES + 1),
])("fails closed on malformed, inconsistent, foreign, or oversized API data", body => {
  expect(() => parseConnpassEvents(body)).toThrow();
});

it("uses the fixed API query and key header, preserves cache on 304, and distinguishes failure from empty", async () => {
  const { feed } = setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(api([event(1)])))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(new Response("bad", { status: 503 }))
    .mockResolvedValueOnce(response(api()));
  await feed.refresh(fetcher, now);
  expect(feed.status).toBe("ok");
  expect(feed.select(now)).toBeUndefined();
  expect(fetcher.mock.calls[0]?.[0]).toBe(CONNPASS_API_URL);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: {
    accept: "application/json",
    "x-api-key": "test-api-key",
  } });

  await feed.refresh(fetcher, later);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: {
    "if-none-match": '"version1"',
    "if-modified-since": "Wed, 16 Sep 2026 00:00:00 GMT",
  } });
  expect(feed.reference("connpassイベント", later)).toHaveLength(1);
  await feed.refresh(fetcher, later + 3600_000); expect(feed.status).toBe("failed");
  await feed.refresh(fetcher, later + 3600_001); expect(fetcher).toHaveBeenCalledTimes(3);
  await feed.refresh(fetcher, later + 7200_000); expect(feed.status).toBe("empty");
});

it("does not make a request without an API key", async () => {
  const { feed } = setup("");
  const fetcher = vi.fn();
  await feed.refresh(fetcher, now);
  expect(feed.status).toBe("failed");
  expect(fetcher).not.toHaveBeenCalled();
});

it("bounds actual response bytes without relying on Content-Length and rejects 304 without cache", async () => {
  const { feed } = setup();
  await feed.refresh(vi.fn().mockResolvedValue(new Response(null, { status: 304 })), now);
  expect(feed.status).toBe("failed");
  await feed.refresh(vi.fn().mockResolvedValue(response("x".repeat(MAX_API_BYTES + 1))), later);
  expect(feed.status).toBe("failed");
  expect(feed.reference("イベント", later + 2 * 86400_000)).toEqual([]);
});

it("migrates the existing Atom-backed cache without making the state unavailable", () => {
  const { path } = setup();
  writeFileSync(path, JSON.stringify({
    initializedAt: now - 3600_000,
    checkedAt: now,
    nextFetchAt: later,
    failures: 0,
    etag: "",
    lastModified: "",
    status: "ok",
    entries: [{
      id: "urn:1",
      url: "https://aid.connpass.com/event/1/",
      title: "既存イベント",
      summary: "既存キャッシュ",
      published: "2026-09-15T00:00:00Z",
      updated: "2026-09-15T01:00:00Z",
      fetchedAt: now,
      eligible: false,
      delivery: "unspoken",
      attemptAt: 0,
      messageId: null,
    }],
    seen: ["urn:1", "https://aid.connpass.com/event/1/"],
    spoken: [],
  }));
  const migrated = new ConnpassFeed(path, undefined, undefined, undefined, "test-api-key");
  expect(migrated.status).toBe("ok");
  expect(migrated.reference("connpassイベント", now)[0]).toMatchObject({
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-09-15T01:00:00Z",
  });
});

it("suppresses first backfill across restart and sends only one new event per day with canonical URL", async () => {
  const { path, feed, store } = setup();
  await feed.refresh(vi.fn().mockResolvedValue(response(api([event(1)]))), now);
  const restarted = new ConnpassFeed(path, undefined, undefined, undefined, "test-api-key");
  await restarted.refresh(vi.fn().mockResolvedValue(response(api([event(1), event(2), event(3)]))), later);
  const generate = vi.fn(async material => {
    expect(material).toContain("public_event_reference");
    expect(material).not.toContain("private-person");
    return "AI開発の工夫、気になります。";
  });
  const send = vi.fn(async text => {
    expect(restarted.delivery("https://aid.connpass.com/event/2/")).toBe("pending");
    expect(text).toContain("https://aid.connpass.com/event/2/");
    return { id: "discord-receipt" };
  });
  await deliverMusing({ background: "private-person", memories: [], feed: restarted, store, generate, send, now: later });
  expect(restarted.delivery("https://aid.connpass.com/event/2/")).toBe("spoken");
  expect(new ConnpassFeed(path, undefined, undefined, undefined, "test-api-key").select(later)).toBeUndefined();
  expect(send).toHaveBeenCalledOnce();
});

it.each([true, false])("only definite rejection releases a send reservation (definite=%s)", async definite => {
  const { feed, path, store } = setup();
  await feed.refresh(vi.fn().mockResolvedValue(response(api())), now);
  await feed.refresh(vi.fn().mockResolvedValue(response(api([event(2)]))), later);
  const options = {
    background: "",
    memories: [],
    feed,
    store,
    generate: async () => "気になる問い",
    send: async () => { throw Object.assign(new Error("send failed"), { status: definite ? 403 : 503 }); },
    now: later,
  };
  await expect(deliverMusing(options)).rejects.toThrow("send failed");
  expect(new ConnpassFeed(path, undefined, undefined, undefined, "test-api-key").delivery("https://aid.connpass.com/event/2/")).toBe(definite ? "unspoken" : "unknown");
  expect(!!new ConnpassFeed(path, undefined, undefined, undefined, "test-api-key").select(later)).toBe(definite);
});

it("generation failures never mark spoken and missing update dates never become new-event posts", async () => {
  const { feed, store } = setup();
  await feed.refresh(vi.fn().mockResolvedValue(response(api())), now);
  await feed.refresh(vi.fn().mockResolvedValue(response(api([event(2), event(3, null)]))), later);
  await expect(deliverMusing({
    background: "",
    memories: [],
    feed,
    store,
    generate: async () => { throw new Error("LLM failed"); },
    send: vi.fn(),
    now: later,
  })).rejects.toThrow();
  expect(feed.delivery("https://aid.connpass.com/event/2/")).toBe("unspoken");
});
