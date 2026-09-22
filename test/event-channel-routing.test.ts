import { expect, it } from "vitest";
import { matchEventBranchChannel } from "../src/gateway/event-channel-routing.js";
import type { EventEntry } from "../src/gateway/connpass-feed.js";

const base: EventEntry = {
  id: "event", url: "https://aid.connpass.com/event/1/", title: "AI駆動開発イベント", summary: "",
  startedAt: "2026-09-25T19:00:00+09:00", endedAt: null, publishedAt: null, updatedAt: null,
  imageUrl: null, hashTag: null, limit: null, accepted: null, waiting: null, eventType: null,
  openStatus: null, groupTitle: null, place: null, address: null, latitude: null, longitude: null,
  fetchedAt: Date.parse("2026-09-22T00:00:00Z"),
};
const branches = [
  { keywords: ["大阪", "osaka"], channelId: "osaka-channel" },
  { keywords: ["広島", "hiroshima"], channelId: "hiroshima-channel" },
];

it("routes a branch event by title before venue metadata", () => {
  expect(matchEventBranchChannel({ ...base, title: "AI駆動開発【大阪支部 #15】", place: "広島" }, branches)).toBe("osaka-channel");
});

it("routes by venue when the event title has no branch", () => {
  expect(matchEventBranchChannel({ ...base, place: "広島市内" }, branches)).toBe("hiroshima-channel");
});

it("keeps unrecognized events in general only", () => {
  expect(matchEventBranchChannel(base, branches)).toBeUndefined();
});
