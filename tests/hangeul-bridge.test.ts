import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatHangeulReport,
  formatHangeulStatus,
  getHangeulReport,
  getHangeulStatus,
  humanizeKey,
  isHangeulQuery,
  isHangeulStatusQuery,
  joinUrl,
  normalizeHangeulReport,
} from "@/lib/agents/hangeul-bridge";

const USER = "admin@hangeul";
const PASSWORD = "p@ss-wörd-secret";
const NOW = new Date("2026-09-27T03:00:00Z");

function configurePortal(baseUrl = "https://hangeul.example/admin") {
  vi.stubEnv("HANGEUL_BASE_URL", baseUrl);
  vi.stubEnv("HANGEUL_USERNAME", USER);
  vi.stubEnv("HANGEUL_PASSWORD", PASSWORD);
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("HANGEUL_BASE_URL", "");
  vi.stubEnv("HANGEUL_USERNAME", "");
  vi.stubEnv("HANGEUL_PASSWORD", "");
  vi.stubEnv("HANGEUL_REPORT_PATH", "");
  vi.stubEnv("HANGEUL_STATUS_PATH", "");
  vi.stubEnv("MOCK_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isHangeulQuery", () => {
  it.each([
    "Show me the Hangeul report",
    "hangeul status",
    "Is the Hangeul portal up?",
    "pull the admin report",
    "send me the daily report",
    "check hangeul",
    "한글 포털 상태 확인해줘",
    "한글 관리자 보고서 보여줘",
    "한글 학원 보고서",
    "어드민 현황 알려줘",
    "일일 보고서",
  ])("routes %j to the bridge", (text) => {
    expect(isHangeulQuery(text)).toBe(true);
  });

  it.each([
    "Teach me hangeul",
    "What is hangeul?",
    "Write a report about the history of hangeul",
    "한글로 보고서 써줘",
    "한글 배우는 법 알려줘",
    "한글날이 언제야?",
  ])("leaves %j to other agents (hangeul is also the alphabet)", (text) => {
    expect(isHangeulQuery(text)).toBe(false);
  });

  it("tells status checks from report requests", () => {
    expect(isHangeulStatusQuery("Is the Hangeul portal up?")).toBe(true);
    expect(isHangeulStatusQuery("한글 포털 상태")).toBe(true);
    expect(isHangeulStatusQuery("Pull up the Hangeul report")).toBe(false);
  });
});

describe("joinUrl", () => {
  it("keeps the base path and tolerates slashes", () => {
    expect(joinUrl("https://hangeul.com.bd/admin", "/api/reports/daily")).toBe("https://hangeul.com.bd/admin/api/reports/daily");
    expect(joinUrl("https://hangeul.com.bd/admin/", "api/status")).toBe("https://hangeul.com.bd/admin/api/status");
    expect(joinUrl("https://hangeul.com.bd", "/api/r?format=json")).toBe("https://hangeul.com.bd/api/r?format=json");
  });
});

describe("mock data", () => {
  it("is deterministic per UTC date and clearly labelled as demo data", async () => {
    const a = await getHangeulReport({ trusted: false, now: new Date("2026-09-27T01:00:00Z") });
    const b = await getHangeulReport({ trusted: false, now: new Date("2026-09-27T22:59:00Z") });
    const c = await getHangeulReport({ trusted: false, now: new Date("2026-09-28T01:00:00Z") });
    expect(a.source).toBe("mock");
    expect(a.title).toMatch(/demo data/i);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.highlights).toEqual(b.highlights);
    expect(c.metrics).not.toEqual(a.metrics);
    expect(a.metrics.map((m) => m.label)).toEqual([
      "Active students",
      "Classes today",
      "Attendance rate",
      "New enquiries",
      "Pending payments",
      "TOPIK registrations",
    ]);
    expect(a.highlights.length).toBeGreaterThanOrEqual(2);
    expect(a.highlights.length).toBeLessThanOrEqual(3);
  });
});

describe("trust gating", () => {
  it("never calls the portal when unconfigured", async () => {
    const fetchMock = mockFetch(() => json({}));
    const report = await getHangeulReport({ trusted: true, now: NOW });
    expect(report.source).toBe("mock");
    expect(report.note).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves demo data to untrusted callers even when configured", async () => {
    configurePortal();
    const fetchMock = mockFetch(() => json({}));
    const report = await getHangeulReport({ trusted: false, now: NOW });
    const status = await getHangeulStatus({ trusted: false, now: NOW });
    expect(report.source).toBe("mock");
    expect(report.note).toMatch(/trusted/);
    expect(status).toMatchObject({ source: "mock", online: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects MOCK_MODE", async () => {
    configurePortal();
    vi.stubEnv("MOCK_MODE", "true");
    const fetchMock = mockFetch(() => json({}));
    const report = await getHangeulReport({ trusted: true, now: NOW });
    expect(report.note).toMatch(/MOCK_MODE/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live portal", () => {
  it("fetches with basic auth and normalizes metrics/highlights arrays", async () => {
    configurePortal();
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe("https://hangeul.example/admin/api/reports/daily");
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      const encoded = headers.get("authorization")?.replace(/^Basic /, "") ?? "";
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
      expect(decoded).toBe(`${USER}:${PASSWORD}`);
      expect(init?.redirect).toBe("manual");
      return json({
        title: "Daily ops",
        generated_at: "2026-09-27T02:00:00Z",
        metrics: [
          { label: "Students", value: 201 },
          { name: "Revenue", value: "₩4.2M" },
          { label: "ignored" },
        ],
        highlights: ["Two new teachers onboarded", { text: "Server backup completed" }],
      });
    });
    const report = await getHangeulReport({ trusted: true, now: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report).toEqual({
      source: "live",
      generatedAt: "2026-09-27T02:00:00.000Z",
      title: "Daily ops",
      metrics: [
        { label: "Students", value: 201 },
        { label: "Revenue", value: "₩4.2M" },
      ],
      highlights: ["Two new teachers onboarded", "Server backup completed"],
    });
  });

  it("flattens top-level primitives into humanized metrics", () => {
    const report = normalizeHangeulReport(
      { data: { active_students: 190, classesToday: 11, attendanceRate: "93%", paid: true, nested: { x: 1 }, id: 7 } },
      NOW,
    );
    expect(report.metrics).toEqual([
      { label: "Active students", value: 190 },
      { label: "Classes today", value: 11 },
      { label: "Attendance rate", value: "93%" },
      { label: "Paid", value: "yes" },
    ]);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(humanizeKey("TOPIK_registrations")).toBe("Topik registrations");
  });

  it.each([
    ["HTTP errors", () => json({ error: "nope" }, 500), /HTTP 500/],
    ["redirects to a login page", () => new Response(null, { status: 302, headers: { location: "https://hangeul.example/login" } }), /redirected/],
    ["non-JSON bodies", () => new Response("<html>login</html>", { status: 200 }), /valid JSON/],
    [
      "network errors that embed the URL",
      () => {
        throw new TypeError(`fetch failed: https://${USER}:${PASSWORD}@hangeul.example`);
      },
      /network error/,
    ],
  ])("falls back to mock data on %s without leaking credentials", async (_label, respond, reason) => {
    configurePortal();
    mockFetch(respond);
    const report = await getHangeulReport({ trusted: true, now: NOW });
    expect(report.source).toBe("mock-fallback");
    expect(report.note).toMatch(reason);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain("hangeul.example");
  });

  it("refuses plain http for remote hosts but allows localhost", async () => {
    configurePortal("http://hangeul.example/admin");
    const fetchMock = mockFetch(() => json({ students: 1 }));
    const remote = await getHangeulReport({ trusted: true, now: NOW });
    expect(remote.source).toBe("mock-fallback");
    expect(remote.note).toMatch(/https/);
    expect(fetchMock).not.toHaveBeenCalled();

    configurePortal("http://localhost:8080");
    const local = await getHangeulReport({ trusted: true, now: NOW });
    expect(local.source).toBe("live");
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://localhost:8080/api/reports/daily");
  });

  it("checks status with latency and reads offline flags", async () => {
    configurePortal();
    vi.stubEnv("HANGEUL_STATUS_PATH", "/health");
    mockFetch((url) => {
      expect(url).toBe("https://hangeul.example/admin/health");
      return json({ status: "maintenance" });
    });
    const status = await getHangeulStatus({ trusted: true, now: NOW });
    expect(status.source).toBe("live");
    expect(status.online).toBe(false);
    expect(typeof status.latencyMs).toBe("number");

    mockFetch(() => new Response("OK", { status: 200 }));
    expect(await getHangeulStatus({ trusted: true, now: NOW })).toMatchObject({ source: "live", online: true });

    mockFetch(() => json({}, 503));
    expect(await getHangeulStatus({ trusted: true, now: NOW })).toMatchObject({ source: "mock-fallback", online: false });
  });
});

describe("formatting", () => {
  it("formats the mock report in English, Korean and bilingual", async () => {
    const report = await getHangeulReport({ trusted: false, now: NOW });
    const en = formatHangeulReport(report, "en");
    const ko = formatHangeulReport(report, "ko");
    expect(en).toContain("Hangeul daily operations report (demo data)");
    expect(en).toContain("• Active students:");
    expect(en).toContain("Note:");
    expect(ko).toContain("한글 학원 일일 운영 보고서 (데모 데이터)");
    expect(ko).toContain("• 재원생:");
    expect(ko).toContain("데모 데이터입니다");
    expect(ko).not.toContain(report.highlights[0]); // highlights are localized too
    expect(formatHangeulReport(report, "bilingual")).toBe(`${en}\n\n—\n\n${ko}`);
  });

  it("formats a status line", () => {
    const text = formatHangeulStatus({ source: "live", online: true, checkedAt: NOW.toISOString(), latencyMs: 120 }, "en");
    expect(text).toBe("Hangeul portal: online\nLatency: 120 ms\nChecked: 2026-09-27 03:00 UTC");
  });
});
