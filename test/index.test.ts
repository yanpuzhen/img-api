import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import worker, { type Env } from "../src/index";

type FetchMock = Mock<(input: RequestInfo | URL) => Promise<Response>>;

const wallpaper = {
  id: "94x38z",
  url: "https://wallhaven.cc/w/94x38z",
  short_url: "https://whvn.cc/94x38z",
  views: 6,
  favorites: 0,
  source: "",
  purity: "sfw",
  category: "anime",
  dimension_x: 6742,
  dimension_y: 3534,
  resolution: "6742x3534",
  ratio: "1.91",
  file_size: 1234,
  file_type: "image/jpeg",
  created_at: "2018-10-31 01:23:10",
  colors: ["#000000"],
  path: "https://w.wallhaven.cc/full/94/wallhaven-94x38z.jpg"
};

const secondWallpaper = {
  ...wallpaper,
  id: "abc123",
  url: "https://wallhaven.cc/w/abc123",
  short_url: "https://whvn.cc/abc123",
  path: "https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("img-api worker", () => {
  it("queries Wallhaven random search with safe defaults", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random");
    const body = await response.json() as { data: typeof wallpaper[]; filters: Record<string, string> };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.filters).toMatchObject({
      sorting: "random",
      categories: "111",
      purity: "100"
    });

    const upstreamUrl = firstFetchedUrl(fetchMock);
    expect(upstreamUrl.origin + upstreamUrl.pathname).toBe("https://wallhaven.cc/api/v1/search");
    expect(upstreamUrl.searchParams.get("sorting")).toBe("random");
    expect(upstreamUrl.searchParams.get("categories")).toBe("111");
    expect(upstreamUrl.searchParams.get("purity")).toBe("100");
  });

  it("passes validated filters through to Wallhaven", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker(
      "https://img-api.example/?q=mountain&categories=101&purity=110&atleast=1920x1080&ratios=16x9,21x9&colors=%230066cc&seed=abc123&page=2"
    );

    expect(response.status).toBe(200);
    const upstreamUrl = firstFetchedUrl(fetchMock);
    expect(searchParamsToObject(upstreamUrl.searchParams)).toMatchObject({
      q: "mountain",
      categories: "101",
      purity: "110",
      atleast: "1920x1080",
      ratios: "16x9,21x9",
      colors: "0066cc",
      seed: "abc123",
      page: "2",
      sorting: "random"
    });
  });

  it("supports multiple JSON results up to Wallhaven page size", async () => {
    mockWallhavenSearch([wallpaper, secondWallpaper]);

    const response = await callWorker("https://img-api.example/random?count=2");
    const body = await response.json() as { count: number; data: typeof wallpaper[] };

    expect(response.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.data.map((item) => item.id)).toEqual(["94x38z", "abc123"]);
  });

  it("rejects invalid query parameters before calling upstream", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?categories=12x");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_categories");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects resolutions below the documented lower bound", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?atleast=001x001");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_atleast");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a Worker secret before allowing NSFW purity", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?purity=101");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("api_key_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the configured Wallhaven secret without exposing it in JSON", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?purity=101", {
      WALLHAVEN_API_KEY: "secret-key"
    });
    const bodyText = await response.text();

    expect(response.status).toBe(200);
    expect(bodyText).not.toContain("secret-key");

    const upstreamUrl = firstFetchedUrl(fetchMock);
    expect(upstreamUrl.searchParams.get("apikey")).toBe("secret-key");
  });

  it("rejects client-supplied API keys", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?apikey=client-secret");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("client_api_key_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects alternate client-supplied API key parameter names", async () => {
    const fetchMock = mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?api_key=client-secret");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("client_api_key_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Wallhaven network failures to a 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const response = await callWorker("https://img-api.example/random");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("wallhaven_unreachable");
  });

  it("maps non-JSON Wallhaven payloads to a 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>blocked</html>", {
      headers: {
        "Content-Type": "text/html"
      }
    })));

    const response = await callWorker("https://img-api.example/random");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("invalid_wallhaven_response");
  });

  it("rejects unexpected upstream image hosts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [
        {
          ...wallpaper,
          path: "https://example.com/wallpaper.jpg"
        }
      ]
    })));

    const response = await callWorker("https://img-api.example/random");
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("invalid_wallhaven_response");
  });

  it("can redirect directly to the selected image", async () => {
    mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?format=redirect");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(wallpaper.path);
    expect(response.headers.get("X-Wallhaven-ID")).toBe(wallpaper.id);
  });

  it("can return the selected image URL as plain text", async () => {
    mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random?format=url");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(await response.text()).toBe(wallpaper.path);
  });

  it("can proxy the selected image", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.startsWith("https://wallhaven.cc/api/v1/search")) {
        return Response.json({ data: [wallpaper] });
      }

      if (url === wallpaper.path) {
        return new Response("image-bytes", {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "11"
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await callWorker("https://img-api.example/random?format=image");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("X-Wallhaven-ID")).toBe(wallpaper.id);
    expect(await response.text()).toBe("image-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles HEAD without a response body", async () => {
    mockWallhavenSearch([wallpaper]);

    const response = await callWorker("https://img-api.example/random", undefined, "HEAD");

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });
});

function mockWallhavenSearch(data: Array<typeof wallpaper>): FetchMock {
  const fetchMock: FetchMock = vi.fn(async () => Response.json({
    data,
    meta: {
      current_page: 1,
      per_page: 24,
      seed: "abc123"
    }
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function firstFetchedUrl(fetchMock: FetchMock): URL {
  const firstCall = fetchMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("Expected fetch to be called at least once.");
  }

  return new URL(firstCall[0].toString());
}

function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function callWorker(url: string, env: Env = {}, method = "GET"): Promise<Response> {
  return worker.fetch(new Request(url, { method }), env);
}
