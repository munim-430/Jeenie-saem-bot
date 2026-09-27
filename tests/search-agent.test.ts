import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearchTool,
  dedupeResults,
  formatSearchBriefing,
  needsLiveSearch,
  parseDuckDuckGoHtml,
  parseDuckDuckGoInstantAnswer,
  parseDuckDuckGoLite,
  resetSearchState,
  webSearch,
} from "@/lib/agents/search-agent";
import type { SearchResult, SourceLink } from "@/lib/types";

const TAVILY_KEY = "tvly-secret-123";
const GOOGLE_KEY = "google-secret-456";

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Trimmed from a real html.duckduckgo.com response, plus an ad and a uddg redirect link.
const DDG_HTML = `
<div class="serp__results"><div id="links" class="results">
  <div class="result results_links results_links_deep result--ad">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Sponsored thing</a></h2>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Buy now</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://www.cnn.com/">Breaking News, Latest News and Videos | CNN</a>
      </h2>
      <div class="result__extras"><a class="result__url" href="https://www.cnn.com/">www.cnn.com</a></div>
      <a class="result__snippet" href="https://www.cnn.com/">View the <b>latest</b> <b>news</b> and breaking <b>news</b> <b>today</b> for U.S., world &amp; more.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cbsnews.com%2Flatest%2F&amp;rut=abc123">CBS News | today&#x27;s latest headlines</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cbsnews.com%2Flatest%2F">CBS <b>News</b> offers breaking coverage.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://apnews.com/">AP News</a></h2>
    </div>
  </div>
</div></div>`;

// Trimmed from a real lite.duckduckgo.com response (single-quoted classes, table rows), plus a sponsored row.
const DDG_LITE = `
<table border="0">
  <tr class="result-sponsored">
    <td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x" class='result-link'>Sponsored forecast app</a></td>
  </tr>
  <tr class="result-sponsored"><td>&nbsp;</td><td class='result-snippet'>Install now</td></tr>
  <tr>
    <td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="https://www.accuweather.com/en/kr/seoul/226081/weather-forecast/226081" class='result-link'>Seoul, Seoul, South Korea Weather Forecast | AccuWeather</a></td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
      <b>Seoul</b>, <b>Seoul</b>, South Korea <b>Weather</b> Forecast, with current conditions &amp; more.
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td>
      <span class='link-text'>www.accuweather.com/en/kr/seoul/226081/weather-forecast/226081</span>
      <span class='timestamp'>2026-09-27T00:00:00.0000000</span>
    </td>
  </tr>
  <tr>
    <td valign="top">3.&nbsp;</td>
    <td><a rel="nofollow" href="https://www.bbc.com/weather/1835848" class='result-link'>Seoul - BBC Weather</a></td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>14-day <b>weather</b> forecast for <b>Seoul</b>.</td>
  </tr>
</table>`;

const DDG_ANOMALY_HTML = `<form id="challenge-form"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></form>`;

const DDG_INSTANT = {
  Heading: "Seoul",
  Answer: "",
  AbstractText: "Seoul is the capital and largest city of South Korea.",
  AbstractURL: "https://en.wikipedia.org/wiki/Seoul",
  AbstractSource: "Wikipedia",
  Results: [{ FirstURL: "https://english.seoul.go.kr/", Text: "Official site", Result: '<a href="https://english.seoul.go.kr/">Official site</a>' }],
  RelatedTopics: [
    { FirstURL: "https://duckduckgo.com/c/Seoul", Text: "Seoul Category", Result: '<a href="https://duckduckgo.com/c/Seoul">Seoul Category</a>' },
    {
      FirstURL: "https://duckduckgo.com/Economy_of_Seoul",
      Text: "Economy of Seoul - Seoul is home to giant business groups.",
      Result: '<a href="https://duckduckgo.com/Economy_of_Seoul">Economy of Seoul</a> - Seoul is home to giant business groups.',
    },
    {
      Name: "Places",
      Topics: [
        {
          FirstURL: "https://duckduckgo.com/Gangnam",
          Text: "Gangnam District A district of Seoul.",
          Result: '<a href="https://duckduckgo.com/Gangnam">Gangnam District</a>A district of Seoul.',
        },
      ],
    },
  ],
};

const EMPTY_INSTANT = { Heading: "", Answer: "", AbstractText: "", AbstractURL: "", Results: [], RelatedTopics: [] };

beforeEach(() => {
  resetSearchState();
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubEnv("GOOGLE_CSE_API_KEY", "");
  vi.stubEnv("GOOGLE_CSE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("needsLiveSearch", () => {
  it.each([
    "What's the latest news on the Fed?",
    "weather in Seoul tomorrow",
    "bitcoin price right now",
    "who won the election?",
    "Is it true that the Louvre is closing?",
    "search for the best ramen in Busan",
    "What happened in 2025?",
    "USD to KRW exchange rate",
    "What's the current Premier League standings",
    "오늘 서울 날씨 어때?",
    "최신 뉴스 알려줘",
    "삼성전자 주가",
    "원달러 환율 알려줘",
    "이거 검색해줘",
    "어제 경기 결과 알려줘",
    "누가 이겼어?",
    "지금 몇 시야?",
  ])("routes %j to live search", (text) => {
    expect(needsLiveSearch(text)).toBe(true);
  });

  it.each([
    "Write me a haiku about the sea",
    "Explain binary search in Python",
    "now make it shorter",
    "Translate 'thank you' into Korean",
    "What is the speed of light?",
    "결과를 요약해줘",
    "이 문장 자연스럽게 고쳐줘",
    "Help me schedule my study plan",
    "",
  ])("keeps %j with the core agent", (text) => {
    expect(needsLiveSearch(text)).toBe(false);
  });
});

describe("DuckDuckGo parsing", () => {
  it("parses the HTML endpoint: skips ads, decodes uddg links and entities, pairs snippets", () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    expect(results.map((r) => r.url)).toEqual(["https://www.cnn.com/", "https://www.cbsnews.com/latest/", "https://apnews.com/"]);
    expect(results[0]).toMatchObject({
      title: "Breaking News, Latest News and Videos | CNN",
      snippet: "View the latest news and breaking news today for U.S., world & more.",
      source: "duckduckgo",
    });
    expect(results[1].title).toBe("CBS News | today's latest headlines");
    expect(results[1].snippet).toBe("CBS News offers breaking coverage.");
    expect(results[2].snippet).toBe("");
  });

  it("parses the lite endpoint: skips sponsored rows, pairs snippets and dates", () => {
    const results = parseDuckDuckGoLite(DDG_LITE);
    expect(results).toEqual([
      {
        title: "Seoul, Seoul, South Korea Weather Forecast | AccuWeather",
        url: "https://www.accuweather.com/en/kr/seoul/226081/weather-forecast/226081",
        snippet: "Seoul, Seoul, South Korea Weather Forecast, with current conditions & more.",
        source: "duckduckgo",
        publishedDate: "2026-09-27T00:00:00.0000000",
      },
      { title: "Seoul - BBC Weather", url: "https://www.bbc.com/weather/1835848", snippet: "14-day weather forecast for Seoul.", source: "duckduckgo" },
    ]);
    expect(parseDuckDuckGoLite(DDG_ANOMALY_HTML)).toEqual([]);
  });

  it("parses instant answers including nested topics and skips category pages", () => {
    const { results, answer } = parseDuckDuckGoInstantAnswer(DDG_INSTANT, "Seoul");
    expect(answer).toBeUndefined();
    expect(results.map((r) => r.url)).toEqual([
      "https://en.wikipedia.org/wiki/Seoul",
      "https://english.seoul.go.kr/",
      "https://duckduckgo.com/Economy_of_Seoul",
      "https://duckduckgo.com/Gangnam",
    ]);
    expect(results[0]).toMatchObject({ title: "Seoul", snippet: "Seoul is the capital and largest city of South Korea." });
    expect(results[2]).toMatchObject({ title: "Economy of Seoul", snippet: "Seoul is home to giant business groups." });
    expect(results[3]).toMatchObject({ title: "Gangnam District", snippet: "A district of Seoul." });
  });

  it("uses Answer/Definition as the quick answer", () => {
    expect(parseDuckDuckGoInstantAnswer({ ...EMPTY_INSTANT, Answer: "4" }, "2+2").answer).toBe("4");
  });
});

describe("dedupeResults", () => {
  it("drops repeated URLs ignoring www, trailing slash and fragments", () => {
    const r = (url: string): SearchResult => ({ title: url, url, snippet: "", source: "tavily" });
    const out = dedupeResults([r("https://www.a.com/x/"), r("https://a.com/x"), r("https://a.com/x#top"), r("https://a.com/y")]);
    expect(out.map((x) => x.url)).toEqual(["https://www.a.com/x/", "https://a.com/y"]);
  });
});

describe("webSearch provider chain", () => {
  it("uses Tavily first with a bearer key and normalizes results", async () => {
    vi.stubEnv("TAVILY_API_KEY", TAVILY_KEY);
    const fetchMock = mockFetch((url, init) => {
      expect(url.href).toBe("https://api.tavily.com/search");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TAVILY_KEY}`);
      expect(JSON.parse(String(init?.body))).toEqual({ query: "k-pop news", max_results: 3, search_depth: "basic", include_answer: true });
      return json({
        answer: "Big week for K-pop.",
        results: [
          { title: "A", url: "https://a.com/1", content: "alpha", published_date: "2026-09-26" },
          { title: "A dup", url: "https://www.a.com/1/", content: "dup" },
          { title: "B", url: "https://b.com/2", content: "beta" },
          { title: "C", url: "https://c.com/3", content: "gamma" },
          { title: "D", url: "https://d.com/4", content: "delta" },
          { title: "bad", url: "javascript:alert(1)", content: "nope" },
        ],
      });
    });

    const res = await webSearch("  k-pop   news ", { maxResults: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe("tavily");
    expect(res.query).toBe("k-pop news");
    expect(res.answer).toBe("Big week for K-pop.");
    expect(res.results.map((r) => r.url)).toEqual(["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
    expect(res.results[0]).toEqual({ title: "A", url: "https://a.com/1", snippet: "alpha", source: "tavily", publishedDate: "2026-09-26" });
  });

  it("falls back Tavily → Google when Tavily fails, without leaking keys", async () => {
    vi.stubEnv("TAVILY_API_KEY", TAVILY_KEY);
    vi.stubEnv("GOOGLE_CSE_API_KEY", GOOGLE_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", "cx-1");
    const fetchMock = mockFetch((url) => {
      if (url.hostname === "api.tavily.com") return json({ error: "quota" }, 429);
      expect(url.hostname).toBe("www.googleapis.com");
      expect(url.searchParams.get("key")).toBe(GOOGLE_KEY);
      expect(url.searchParams.get("cx")).toBe("cx-1");
      expect(url.searchParams.get("q")).toBe("seoul weather");
      expect(url.searchParams.get("num")).toBe("5");
      return json({
        items: [
          { title: "Seoul forecast", link: "https://weather.example/seoul", snippet: "Sunny", pagemap: { metatags: [{ "article:published_time": "2026-09-27T01:00:00Z" }] } },
        ],
      });
    });

    const res = await webSearch("seoul weather");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.provider).toBe("google");
    expect(res.results[0]).toMatchObject({ title: "Seoul forecast", source: "google", publishedDate: "2026-09-27T01:00:00Z" });
    expect(JSON.stringify(res)).not.toContain(GOOGLE_KEY);
  });

  it("falls through to DuckDuckGo instant answers when keyed providers return nothing", async () => {
    vi.stubEnv("TAVILY_API_KEY", TAVILY_KEY);
    mockFetch((url) => {
      if (url.hostname === "api.tavily.com") return json({ results: [] });
      expect(url.hostname).toBe("api.duckduckgo.com");
      expect(url.searchParams.get("format")).toBe("json");
      // DuckDuckGo really answers 202 with a javascript content type.
      return new Response(JSON.stringify(DDG_INSTANT), { status: 202, headers: { "content-type": "application/x-javascript" } });
    });
    const res = await webSearch("Seoul");
    expect(res.provider).toBe("duckduckgo");
    expect(res.results[0].url).toBe("https://en.wikipedia.org/wiki/Seoul");
  });

  it("uses the DuckDuckGo HTML endpoint (POST) when instant answers are empty", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.hostname === "api.duckduckgo.com") return new Response(JSON.stringify(EMPTY_INSTANT), { status: 202 });
      expect(url.href).toBe("https://html.duckduckgo.com/html/");
      expect(init?.method).toBe("POST");
      expect(new URLSearchParams(String(init?.body)).get("q")).toBe("latest news today");
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/Mozilla\/5\.0/);
      return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
    });
    const res = await webSearch("latest news today", { maxResults: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.provider).toBe("duckduckgo");
    expect(res.results.map((r) => r.url)).toEqual(["https://www.cnn.com/", "https://www.cbsnews.com/latest/"]);
  });

  it("fails over to the lite endpoint after a bot challenge and skips the challenged page for a minute", async () => {
    const pages: string[] = [];
    mockFetch((url, init) => {
      if (url.hostname === "api.duckduckgo.com") return new Response(JSON.stringify(EMPTY_INSTANT), { status: 202 });
      pages.push(url.hostname);
      expect(init?.method).toBe("POST");
      if (url.hostname === "html.duckduckgo.com") return new Response(DDG_ANOMALY_HTML, { status: 202 });
      expect(url.href).toBe("https://lite.duckduckgo.com/lite/");
      return new Response(DDG_LITE, { status: 200, headers: { "content-type": "text/html" } });
    });

    const first = await webSearch("seoul weather tomorrow");
    expect(first.provider).toBe("duckduckgo");
    expect(first.results.map((r) => r.url)).toEqual([
      "https://www.accuweather.com/en/kr/seoul/226081/weather-forecast/226081",
      "https://www.bbc.com/weather/1835848",
    ]);
    expect(pages).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com"]);

    // The HTML page is cooling down after its challenge, so the next search goes straight to lite.
    await webSearch("busan weather tomorrow");
    expect(pages).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com", "lite.duckduckgo.com"]);
  });

  it("reuses a successful search for the same query instead of calling providers again", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.hostname === "api.duckduckgo.com") return new Response(JSON.stringify(DDG_INSTANT), { status: 202 });
      throw new Error(`unexpected ${url.href}`);
    });
    const first = await webSearch("Seoul");
    const second = await webSearch("  seoul ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual(first.results);
    // A different result count is a different search.
    await webSearch("Seoul", { maxResults: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls++;
      if (url.hostname === "api.duckduckgo.com") return new Response(JSON.stringify(EMPTY_INSTANT), { status: 202 });
      return new Response(DDG_ANOMALY_HTML, { status: 202 });
    });
    const first = await webSearch("no luck");
    const callsAfterFirst = calls;
    const second = await webSearch("no luck");
    expect(first.provider).toBe("none");
    expect(second.provider).toBe("none");
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });

  it("reports an error when every provider fails (bot challenge, HTTP errors, network)", async () => {
    vi.stubEnv("TAVILY_API_KEY", TAVILY_KEY);
    vi.stubEnv("GOOGLE_CSE_API_KEY", GOOGLE_KEY);
    vi.stubEnv("GOOGLE_CSE_ID", "cx-1");
    mockFetch((url) => {
      if (url.hostname === "api.tavily.com") return json({}, 401);
      if (url.hostname === "www.googleapis.com") throw new TypeError(`fetch failed for ${url.href}`);
      if (url.hostname === "api.duckduckgo.com") return new Response(JSON.stringify(EMPTY_INSTANT), { status: 202 });
      return new Response(DDG_ANOMALY_HTML, { status: 202 });
    });
    const res = await webSearch("anything");
    expect(res.provider).toBe("none");
    expect(res.results).toEqual([]);
    expect(res.error).toContain("tavily: HTTP 401");
    expect(res.error).toContain("google: network error");
    expect(res.error).toContain("duckduckgo: bot challenge");
    expect(res.error).not.toContain(GOOGLE_KEY);
    expect(res.error).not.toContain(TAVILY_KEY);
  });

  it("moves on when a provider hangs past its timeout", async () => {
    vi.stubEnv("TAVILY_API_KEY", TAVILY_KEY);
    mockFetch((url, init) => {
      if (url.hostname === "api.tavily.com") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return new Response(JSON.stringify(DDG_INSTANT), { status: 202 });
    });
    const res = await webSearch("Seoul", { providerTimeoutMs: 50 });
    expect(res.provider).toBe("duckduckgo");
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("does not call any provider for an already-aborted signal or an empty query", async () => {
    const fetchMock = mockFetch(() => json({}));
    const controller = new AbortController();
    controller.abort();
    expect((await webSearch("news", { signal: controller.signal })).error).toBe("Search cancelled.");
    expect((await webSearch("   ")).error).toBe("Empty search query.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("formatSearchBriefing", () => {
  it("numbers results as [n] title (date) — snippet — url", () => {
    const text = formatSearchBriefing({
      query: "q",
      provider: "tavily",
      answer: "Short answer.",
      results: [
        { title: "One", url: "https://one.com/", snippet: "first", source: "tavily", publishedDate: "2026-09-26T10:00:00Z" },
        { title: "Two", url: "https://two.com/", snippet: "", source: "tavily" },
      ],
    });
    expect(text.split("\n")).toEqual([
      'Live web results for "q" (via Tavily):',
      "Quick answer: Short answer.",
      "[1] One (2026-09-26) — first — https://one.com/",
      "[2] Two — https://two.com/",
    ]);
  });

  it("explains empty results", () => {
    expect(formatSearchBriefing({ query: "q", provider: "none", results: [], error: "No live results." })).toBe(
      'No live web results for "q". No live results.',
    );
  });
});

describe("createSearchTool", () => {
  it("returns compact results and reports sources", async () => {
    mockFetch((url) =>
      url.hostname === "api.duckduckgo.com"
        ? new Response(JSON.stringify(DDG_INSTANT), { status: 202 })
        : new Response("", { status: 500 }),
    );
    const seen: SourceLink[][] = [];
    const searchTool = createSearchTool((s) => seen.push(s));
    const output = await searchTool.execute!({ query: "Seoul" }, { toolCallId: "t1", messages: [], context: {} });
    expect(output).toMatchObject({ provider: "duckduckgo", error: null });
    expect((output as { results: Array<{ n: number }> }).results[0].n).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual({ title: "Seoul", url: "https://en.wikipedia.org/wiki/Seoul" });
  });
});

// Real network check, opt-in: LIVE_SEARCH=1 npx vitest run tests/search-agent.test.ts
describe.skipIf(!process.env.LIVE_SEARCH)("DuckDuckGo live", () => {
  it("instant answers return real results for an entity", async () => {
    const res = await webSearch("Seoul");
    expect(res.provider).toBe("duckduckgo");
    expect(res.results.length).toBeGreaterThan(0);
  }, 20_000);

  it("the HTML fallback returns results or a clean error", async () => {
    const res = await webSearch("latest news today");
    console.info("[live] html fallback:", res.provider, res.results.length, res.error ?? "");
    if (res.provider === "none") expect(res.error).toMatch(/duckduckgo/);
    else expect(res.results.length).toBeGreaterThan(0);
  }, 20_000);
});
