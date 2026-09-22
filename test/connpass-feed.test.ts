import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConnpassFeed, CONNPASS_API_URL, MAX_API_BYTES, eventConversationMaterial, parseConnpassEvents, eventReference } from "../src/gateway/connpass-feed.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = Date.parse("2026-09-16T00:00:00Z");
const interval = 6 * 3600_000;
const later = now + interval;
const event = (id: number, updatedAt: string | null = "2026-09-16T00:01:00Z") => ({
  event_id: id,
  title: `AI駆動開発勉強会 ${id}`,
  catch: "公開情報",
  description: "<p>APIの説明</p><script>bad()</script>",
  event_url: `https://aid.connpass.com/event/${id}/?utm_source=api`,
  started_at: "2026-09-20T19:00:00+09:00",
  ended_at: "2026-09-20T21:00:00+09:00",
  published_at: "2026-09-15T12:00:00+09:00",
  updated_at: updatedAt,
  image_url: "https://media.connpass.com/example.png",
  hash_tag: "AI駆動開発",
  limit: 44,
  accepted: 42,
  waiting: 1,
  event_type: "participation",
  open_status: "open",
  group: { subdomain: "aid", title: "AI駆動開発", url: "https://aid.connpass.com/" },
  place: "大阪会場",
  address: "大阪府大阪市",
  lat: "34.7",
  lon: "135.5",
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
  return { path, feed: new ConnpassFeed(path, undefined, undefined, apiKey) };
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
    publishedAt: "2026-09-15T12:00:00+09:00",
    updatedAt: "2026-09-16T00:01:00Z",
    imageUrl: "https://media.connpass.com/example.png",
    hashTag: "AI駆動開発",
    limit: 44,
    accepted: 42,
    waiting: 1,
    eventType: "participation",
    openStatus: "open",
    groupTitle: "AI駆動開発",
    place: "大阪会場",
    address: "大阪府大阪市",
    latitude: 34.7,
    longitude: 135.5,
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
  expect(feed.snapshot()).toMatchObject({
    status: "ok",
    checkedAt: "2026-09-16T00:00:00.000Z",
    nextFetchAt: "2026-09-16T06:00:00.000Z",
    failures: 0,
    entries: 1,
  });
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
  await feed.refresh(fetcher, later + interval); expect(feed.status).toBe("failed");
  await feed.refresh(fetcher, later + interval + 1); expect(fetcher).toHaveBeenCalledTimes(3);
  await feed.refresh(fetcher, later + 2 * interval); expect(feed.status).toBe("empty");
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
  const migrated = new ConnpassFeed(path, undefined, undefined, "test-api-key");
  expect(migrated.status).toBe("ok");
  expect(migrated.reference("connpassイベント", now)[0]).toMatchObject({
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-09-15T01:00:00Z",
  });
});

it("selects three-day, previous-day and event-day conversation moments once each", async () => {
  const { feed } = setup();
  const startsAt = "2026-09-20T19:00:00+09:00";
  const payload = api([
    { ...event(10), started_at: startsAt },
    { ...event(11), title: "【中止】別のイベント", started_at: startsAt },
  ]);

  const threeDaysBefore = Date.parse("2026-09-17T03:00:00Z");
  await feed.refresh(vi.fn().mockResolvedValue(response(payload)), threeDaysBefore);
  const first = feed.selectConversationMoment(threeDaysBefore);
  expect(first).toMatchObject({ key: "10:three_days_before", stage: "three_days_before", daysUntil: 3 });
  const threeDayMaterial = eventConversationMaterial(first!, 12);
  expect(threeDayMaterial).toContain("開催3日前。本文に『3日後』と書く");
  expect(threeDayMaterial).toContain("正式なイベント名と開催日時を必ず書く");
  expect(threeDayMaterial).toContain("告知を9割");
  expect(threeDayMaterial).toContain("学校・授業・レジなど、参照データにない自分の行動や体験を作らない");
  expect(feed.reserveConversationMoment(first!.key, threeDaysBefore)).toBe(true);
  feed.deliveredConversationMoment(first!.key, "discord-3d");
  expect(feed.selectConversationMoment(threeDaysBefore)).toBeUndefined();

  const oneDayBefore = Date.parse("2026-09-19T03:00:00Z");
  await feed.refresh(vi.fn().mockResolvedValue(response(payload)), oneDayBefore);
  const second = feed.selectConversationMoment(oneDayBefore);
  expect(second).toMatchObject({ key: "10:one_day_before", stage: "one_day_before", daysUntil: 1 });
  expect(eventConversationMaterial(second!, 12)).toContain("開催前日。本文に『明日』と書く");
  expect(feed.reserveConversationMoment(second!.key, oneDayBefore)).toBe(true);
  feed.deliveredConversationMoment(second!.key, "discord-1d");

  const eventDay = Date.parse("2026-09-20T03:00:00Z");
  await feed.refresh(vi.fn().mockResolvedValue(response(payload)), eventDay);
  const third = feed.selectConversationMoment(eventDay);
  expect(third).toMatchObject({ key: "10:event_day", stage: "event_day", daysUntil: 0 });
  expect(eventConversationMaterial(third!, 12)).toContain("開催当日（開始前）。本文に『本日』または『今日』と書く");
  expect(feed.reserveConversationMoment(third!.key, eventDay)).toBe(true);
  feed.deliveredConversationMoment(third!.key, "discord-day");
  expect(feed.selectConversationMoment(Date.parse("2026-09-20T11:00:01Z"))).toBeUndefined();
});

it("releases a definitely failed event post but holds an ambiguous send", async () => {
  const { feed } = setup();
  const at = Date.parse("2026-09-17T03:00:00Z");
  await feed.refresh(vi.fn().mockResolvedValue(response(api([{ ...event(20), started_at: "2026-09-20T19:00:00+09:00" }]))), at);
  const moment = feed.selectConversationMoment(at)!;
  expect(feed.reserveConversationMoment(moment.key, at)).toBe(true);
  feed.failedConversationMoment(moment.key, true);
  expect(feed.selectConversationMoment(at)?.key).toBe(moment.key);
  expect(feed.reserveConversationMoment(moment.key, at)).toBe(true);
  feed.failedConversationMoment(moment.key, false);
  expect(feed.selectConversationMoment(at)).toBeUndefined();
});

it("persists and retries a regional conversation copy independently from the primary post", async () => {
  const { feed } = setup();
  const now = Date.parse("2026-09-22T03:00:00Z");
  expect(feed.queueConversationCopy("405783:three_days_before", "osaka", "本文\nhttps://aid.connpass.com/event/405783/", now)).toBe(true);
  expect(feed.queueConversationCopy("405783:three_days_before", "osaka", "重複", now)).toBe(false);
  const copy = feed.dueConversationCopies(now)[0]!;
  expect(copy).toMatchObject({ channelId: "osaka", attempts: 0, status: "pending" });
  expect(feed.beginConversationCopyAttempt(copy.key, now)).toBe(1);
  feed.deferConversationCopy(copy.key, "network reset", now);
  expect(feed.dueConversationCopies(now + 59_999)).toEqual([]);
  expect(feed.dueConversationCopies(now + 60_000)).toHaveLength(1);
  feed.beginConversationCopyAttempt(copy.key, now + 60_000);
  feed.deliveredConversationCopy(copy.key, "osaka-message");
  expect(feed.dueConversationCopies(now + 86400_000)).toEqual([]);
  expect(feed.snapshot().pendingCopies).toBe(0);
});
