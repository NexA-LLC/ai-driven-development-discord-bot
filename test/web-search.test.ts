import { expect, it, vi } from "vitest";
import { parseGoogleNewsRss, searchWeb } from "../src/gateway/web-search.js";

const rss = `<?xml version="1.0"?><rss><channel>
  <item><title>新しいAI発表 &amp; 開発者向け機能 - Example</title>
    <link>https://news.google.com/rss/articles/example?oc=5</link>
    <pubDate>Sat, 19 Sep 2026 12:00:00 GMT</pubDate>
    <source url="https://example.com">Example News</source></item>
</channel></rss>`;

it("parses bounded Google News metadata without article bodies", () => {
  expect(parseGoogleNewsRss(rss)).toEqual([{
    title: "新しいAI発表 & 開発者向け機能 - Example",
    url: "https://news.google.com/rss/articles/example?oc=5",
    source: "Example News",
    publishedAt: "2026-09-19T12:00:00.000Z",
  }]);
});

it("rejects non-Google result URLs instead of turning RSS into arbitrary fetching", () => {
  expect(() => parseGoogleNewsRss(rss.replace("https://news.google.com", "https://attacker.example")))
    .toThrow("no validated items");
});

it("searches a fixed endpoint with bounded freshness and returns source metadata", async () => {
  const fetchImpl = vi.fn(async () => new Response(rss, { status: 200 }));
  const result = await searchWeb("最新AI", { freshnessDays: 1, now: Date.parse("2026-09-19T13:00:00Z"), fetchImpl });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const url = fetchImpl.mock.calls[0]![0] as URL;
  expect(url.origin + url.pathname).toBe("https://news.google.com/rss/search");
  expect(url.searchParams.get("q")).toBe("最新AI when:1d");
  expect(result).toMatchObject({ provider: "Google News RSS", scope: "news", query: "最新AI", searchedAt: "2026-09-19T13:00:00.000Z" });
  expect(result.results).toHaveLength(1);
});

it("rejects empty and overlong searches before network access", async () => {
  const fetchImpl = vi.fn();
  await expect(searchWeb(" ", { fetchImpl })).rejects.toThrow("2〜160");
  await expect(searchWeb("x".repeat(161), { fetchImpl })).rejects.toThrow("2〜160");
  await expect(searchWeb("token=super-secret-value", { fetchImpl })).rejects.toThrow("秘密・個人識別情報");
  await expect(searchWeb("someone@example.com のニュース", { fetchImpl })).rejects.toThrow("秘密・個人識別情報");
  expect(fetchImpl).not.toHaveBeenCalled();
});
