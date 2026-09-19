const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_QUERIES = 50;
const CACHE_MS = 5 * 60_000;
const SENSITIVE_QUERY = /(?:Bearer\s+[A-Za-z0-9._-]+|(?:password|api[_-]?key|secret|token)\s*[:=]\s*\S+|sk-[A-Za-z0-9_-]{8,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b\d{12,}\b)/i;

export interface WebSearchItem {
  title: string;
  url: string;
  source: string | null;
  publishedAt: string | null;
}

export interface WebSearchResult {
  provider: "Google News RSS";
  scope: "news";
  query: string;
  searchedAt: string;
  results: WebSearchItem[];
}

interface CachedSearch { at: number; items: WebSearchItem[] }
const cache = new Map<string, CachedSearch>();

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .trim();
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
  return decodeXml(match?.[1] ?? "");
}

/** Parse only bounded Google News RSS metadata; article bodies and arbitrary URLs are never fetched. */
export function parseGoogleNewsRss(xml: string, limit = 15): WebSearchItem[] {
  if (xml.length > MAX_RESPONSE_BYTES) throw new Error("Google News RSS response is too large");
  const items: WebSearchItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title").slice(0, 300);
    const rawUrl = extractTag(block, "link");
    const source = extractTag(block, "source").slice(0, 120) || null;
    let url: URL;
    try { url = new URL(rawUrl); } catch { continue; }
    if (!title || url.protocol !== "https:" || url.hostname !== "news.google.com" || seen.has(url.href)) continue;
    const published = extractTag(block, "pubDate");
    const timestamp = Date.parse(published);
    items.push({ title, url: url.href, source, publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null });
    seen.add(url.href);
    if (items.length >= Math.max(1, Math.min(15, limit))) break;
  }
  if (!items.length) throw new Error("Google News RSS returned no validated items");
  return items;
}

function searchUrl(query: string, freshnessDays: number): URL {
  const url = new URL(GOOGLE_NEWS_RSS);
  // Freshness is a code-enforced bound, not an operator supplied by the model or user.
  const boundedQuery = query.replace(/\bwhen:\d+[dhmy]\b/gi, "").replace(/\s+/g, " ").trim();
  url.search = new URLSearchParams({
    q: `${boundedQuery} when:${freshnessDays}d`,
    hl: "ja",
    gl: "JP",
    ceid: "JP:ja",
  }).toString();
  return url;
}

export async function searchWeb(
  rawQuery: string,
  options: { freshnessDays?: number; limit?: number; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchResult> {
  const query = rawQuery.trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 160) throw new Error("検索語は2〜160文字にしてください");
  if (SENSITIVE_QUERY.test(query)) throw new Error("秘密・個人識別情報を検索語には送れません");
  const freshnessDays = Math.max(1, Math.min(30, Math.round(options.freshnessDays ?? 7)));
  const limit = Math.max(1, Math.min(15, Math.round(options.limit ?? 5)));
  const now = options.now ?? Date.now();
  const key = `${freshnessDays}:${query.toLocaleLowerCase("ja")}`;
  let items = cache.get(key)?.at && now - (cache.get(key)?.at ?? 0) < CACHE_MS ? cache.get(key)!.items : undefined;

  if (!items) {
    const fetchImpl = options.fetchImpl ?? fetch;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetchImpl(searchUrl(query, freshnessDays), {
          headers: { "user-agent": "ai-driven-development-discord-bot/0.1" },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Google News RSS returned ${response.status}`);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_RESPONSE_BYTES) throw new Error("Google News RSS response is too large");
        items = parseGoogleNewsRss(await response.text(), 15);
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
    }
    if (!items) throw lastError ?? new Error("Google News RSS search failed");
    cache.set(key, { at: now, items });
    while (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value as string);
  }

  return {
    provider: "Google News RSS",
    scope: "news",
    query,
    searchedAt: new Date(now).toISOString(),
    results: items.slice(0, limit),
  };
}
