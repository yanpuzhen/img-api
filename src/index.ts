const WALLHAVEN_SEARCH_URL = "https://wallhaven.cc/api/v1/search";
const MAX_QUERY_LENGTH = 200;
const MAX_LIST_LENGTH = 20;
const MAX_COUNT = 24;
const MAX_PAGE = 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
} as const;

type ResponseFormat = "json" | "redirect" | "image" | "url";

export interface Env {
  WALLHAVEN_API_KEY?: string;
  WALLHAVEN_DEFAULT_CATEGORIES?: string;
  WALLHAVEN_DEFAULT_PURITY?: string;
  WALLHAVEN_DEFAULT_QUERY?: string;
}

interface Wallpaper {
  id: string;
  url: string;
  short_url: string;
  views: number;
  favorites: number;
  source: string;
  purity: string;
  category: string;
  dimension_x: number;
  dimension_y: number;
  resolution: string;
  ratio: string;
  file_size: number;
  file_type: string;
  created_at: string;
  colors: string[];
  path: string;
  thumbs?: Record<string, string>;
}

interface WallhavenSearchResponse {
  data: Wallpaper[];
  meta?: {
    current_page?: number;
    last_page?: number;
    per_page?: number;
    total?: number;
    query?: string | null;
    seed?: string;
  };
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface SearchOptions {
  categories: string;
  purity: string;
  count: number;
  format: ResponseFormat;
  filters: URLSearchParams;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: error.code,
              message: error.message
            }
          },
          {
            status: error.status,
            head: request.method === "HEAD"
          }
        );
      }

      console.error("Unhandled worker error", error);
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "internal_error",
            message: "The image API failed unexpectedly."
          }
        },
        {
          status: 500,
          head: request.method === "HEAD"
        }
      );
    }
  }
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: commonHeaders() });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "method_not_allowed",
          message: "Use GET, HEAD, or OPTIONS."
        }
      },
      {
        status: 405,
        head: false,
        headers: {
          Allow: "GET, HEAD, OPTIONS"
        }
      }
    );
  }

  const url = new URL(request.url);
  const pathname = normalizePathname(url.pathname);

  if (pathname === "/health") {
    return jsonResponse(
      {
        ok: true,
        service: "img-api",
        upstream: "wallhaven"
      },
      {
        head: request.method === "HEAD"
      }
    );
  }

  if (pathname !== "/" && pathname !== "/random") {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "not_found",
          message: "Use / or /random for a random Wallhaven wallpaper."
        }
      },
      {
        status: 404,
        head: request.method === "HEAD"
      }
    );
  }

  const options = parseSearchOptions(url.searchParams, env);
  const upstreamUrl = buildWallhavenUrl(options, env);
  const upstreamResponse = await fetchWallhavenSearch(upstreamUrl);

  if (!upstreamResponse.ok) {
    throw new ApiError(
      502,
      "wallhaven_request_failed",
      `Wallhaven returned HTTP ${upstreamResponse.status}.`
    );
  }

  const payload = await readWallhavenPayload(upstreamResponse);
  const wallpapers = payload.data.slice(0, options.count);

  if (wallpapers.length === 0) {
    throw new ApiError(
      404,
      "no_wallpaper_found",
      "Wallhaven returned no wallpapers for these filters."
    );
  }

  const firstWallpaper = wallpapers.at(0);
  if (!firstWallpaper) {
    throw new ApiError(404, "no_wallpaper_found", "Wallhaven returned no wallpapers for these filters.");
  }

  if (options.format === "redirect") {
    return redirectResponse(firstWallpaper, request.method === "HEAD");
  }

  if (options.format === "image") {
    return proxyImage(firstWallpaper, request.method === "HEAD");
  }

  if (options.format === "url") {
    return textResponse(firstWallpaper.path, {
      head: request.method === "HEAD",
      headers: wallpaperHeaders(firstWallpaper)
    });
  }

  return jsonResponse(
    {
      ok: true,
      count: wallpapers.length,
      source: {
        provider: "wallhaven",
        endpoint: WALLHAVEN_SEARCH_URL
      },
      filters: searchParamsToObject(options.filters),
      meta: payload.meta ?? null,
      data: wallpapers
    },
    {
      head: request.method === "HEAD"
    }
  );
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function parseSearchOptions(params: URLSearchParams, env: Env): SearchOptions {
  if (params.has("apikey") || params.has("apiKey") || params.has("api_key")) {
    throw new ApiError(
      400,
      "client_api_key_rejected",
      "Configure WALLHAVEN_API_KEY as a Worker secret instead of passing API keys in URLs."
    );
  }

  const categories = parseBitmask(
    params.get("categories") ?? env.WALLHAVEN_DEFAULT_CATEGORIES ?? "111",
    "categories"
  );
  const purity = parseBitmask(
    params.get("purity") ?? env.WALLHAVEN_DEFAULT_PURITY ?? "100",
    "purity"
  );

  if (purity[2] === "1" && !env.WALLHAVEN_API_KEY) {
    throw new ApiError(
      400,
      "api_key_required",
      "NSFW Wallhaven results require the WALLHAVEN_API_KEY Worker secret."
    );
  }

  const count = parseInteger(params.get("count"), "count", 1, MAX_COUNT, 1) ?? 1;
  const format = parseFormat(params.get("format"));
  const filters = new URLSearchParams();

  filters.set("sorting", "random");
  filters.set("categories", categories);
  filters.set("purity", purity);

  const q = params.get("q") ?? env.WALLHAVEN_DEFAULT_QUERY;
  if (q !== undefined && q.trim() !== "") {
    const trimmed = q.trim();
    if (trimmed.length > MAX_QUERY_LENGTH) {
      throw new ApiError(400, "invalid_q", `q must be ${MAX_QUERY_LENGTH} characters or less.`);
    }
    filters.set("q", trimmed);
  }

  addOptionalList(params, filters, "resolutions", parseResolution);
  addOptionalList(params, filters, "ratios", parseRatio);
  addOptionalSingle(params, filters, "atleast", parseResolution);
  addOptionalSingle(params, filters, "colors", parseColor);
  addOptionalSingle(params, filters, "seed", parseSeed);

  const page = parseInteger(params.get("page"), "page", 1, MAX_PAGE, undefined);
  if (page !== undefined) {
    filters.set("page", String(page));
  }

  return {
    categories,
    purity,
    count,
    format,
    filters
  };
}

function buildWallhavenUrl(options: SearchOptions, env: Env): URL {
  const upstreamUrl = new URL(WALLHAVEN_SEARCH_URL);
  options.filters.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  if (env.WALLHAVEN_API_KEY) {
    upstreamUrl.searchParams.set("apikey", env.WALLHAVEN_API_KEY);
  }

  return upstreamUrl;
}

async function readWallhavenPayload(response: Response): Promise<WallhavenSearchResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, "invalid_wallhaven_response", "Wallhaven returned a non-JSON payload.");
  }

  if (!isWallhavenSearchResponse(payload)) {
    throw new ApiError(502, "invalid_wallhaven_response", "Wallhaven returned an unexpected payload.");
  }

  return payload;
}

function isWallhavenSearchResponse(value: unknown): value is WallhavenSearchResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) && data.every(isWallpaper);
}

function isWallpaper(value: unknown): value is Wallpaper {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<keyof Wallpaper, unknown>>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.short_url === "string" &&
    typeof candidate.path === "string" &&
    isTrustedWallhavenImageUrl(candidate.path) &&
    typeof candidate.purity === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.resolution === "string" &&
    typeof candidate.ratio === "string" &&
    typeof candidate.file_type === "string" &&
    typeof candidate.created_at === "string" &&
    typeof candidate.views === "number" &&
    typeof candidate.favorites === "number" &&
    typeof candidate.dimension_x === "number" &&
    typeof candidate.dimension_y === "number" &&
    typeof candidate.file_size === "number" &&
    Array.isArray(candidate.colors)
  );
}

function isTrustedWallhavenImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "w.wallhaven.cc" && url.pathname.startsWith("/full/");
  } catch {
    return false;
  }
}

function parseBitmask(value: string, field: string): string {
  if (!/^[01]{3}$/.test(value)) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be a three-digit 0/1 bitmask, such as 100 or 111.`);
  }

  if (value === "000") {
    throw new ApiError(400, `invalid_${field}`, `${field} must enable at least one option.`);
  }

  return value;
}

function parseInteger(
  rawValue: string | null,
  field: string,
  min: number,
  max: number,
  fallback: number | undefined
): number | undefined {
  if (rawValue === null || rawValue.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be an integer.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be between ${min} and ${max}.`);
  }

  return value;
}

function parseFormat(rawValue: string | null): ResponseFormat {
  if (rawValue === null || rawValue === "") {
    return "json";
  }

  if (rawValue === "json" || rawValue === "redirect" || rawValue === "image" || rawValue === "url") {
    return rawValue;
  }

  throw new ApiError(400, "invalid_format", "format must be one of: json, redirect, image, url.");
}

function addOptionalSingle(
  params: URLSearchParams,
  filters: URLSearchParams,
  key: string,
  parser: (value: string, field: string) => string
): void {
  const rawValue = params.get(key);
  if (rawValue === null || rawValue.trim() === "") {
    return;
  }

  filters.set(key, parser(rawValue.trim(), key));
}

function addOptionalList(
  params: URLSearchParams,
  filters: URLSearchParams,
  key: string,
  parser: (value: string, field: string) => string
): void {
  const rawValue = params.get(key);
  if (rawValue === null || rawValue.trim() === "") {
    return;
  }

  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0 || values.length > MAX_LIST_LENGTH) {
    throw new ApiError(400, `invalid_${key}`, `${key} must contain between 1 and ${MAX_LIST_LENGTH} values.`);
  }

  filters.set(
    key,
    values.map((value) => parser(value, key)).join(",")
  );
}

function parseResolution(value: string, field: string): string {
  if (!/^\d{3,5}x\d{3,5}$/.test(value)) {
    throw new ApiError(400, `invalid_${field}`, `${field} values must look like 1920x1080.`);
  }

  const [width, height] = value.split("x").map(Number);
  if (!width || !height || width < 100 || height < 100 || width > 20000 || height > 20000) {
    throw new ApiError(400, `invalid_${field}`, `${field} values must be between 100 and 20000 pixels.`);
  }

  return value;
}

function parseRatio(value: string, field: string): string {
  if (!/^\d{1,3}x\d{1,3}$/.test(value)) {
    throw new ApiError(400, `invalid_${field}`, `${field} values must look like 16x9.`);
  }

  return value;
}

function parseColor(value: string, field: string): string {
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be a 6-digit hex color, such as 0066cc.`);
  }

  return normalized.toLowerCase();
}

function parseSeed(value: string, field: string): string {
  if (!/^[a-zA-Z0-9]{6}$/.test(value)) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be a 6-character alphanumeric Wallhaven seed.`);
  }

  return value;
}

async function proxyImage(wallpaper: Wallpaper, head: boolean): Promise<Response> {
  const imageResponse = await fetchWallhavenImage(wallpaper, head);

  if (!imageResponse.ok) {
    throw new ApiError(
      502,
      "wallhaven_image_failed",
      `Wallhaven image request returned HTTP ${imageResponse.status}.`
    );
  }

  const headers = commonHeaders({
    ...wallpaperHeaders(wallpaper),
    "Content-Type": imageResponse.headers.get("Content-Type") ?? wallpaper.file_type,
    "Content-Length": imageResponse.headers.get("Content-Length") ?? String(wallpaper.file_size)
  });

  return new Response(head ? null : imageResponse.body, {
    status: 200,
    headers
  });
}

async function fetchWallhavenSearch(upstreamUrl: URL): Promise<Response> {
  try {
    return await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "img-api-worker/1.0"
      }
    });
  } catch {
    throw new ApiError(502, "wallhaven_unreachable", "Wallhaven search is temporarily unreachable.");
  }
}

async function fetchWallhavenImage(wallpaper: Wallpaper, head: boolean): Promise<Response> {
  try {
    return await fetch(wallpaper.path, {
      method: head ? "HEAD" : "GET",
      headers: {
        Accept: wallpaper.file_type,
        Referer: wallpaper.url,
        "User-Agent": "img-api-worker/1.0"
      }
    });
  } catch {
    throw new ApiError(502, "wallhaven_image_unreachable", "The selected Wallhaven image is temporarily unreachable.");
  }
}

function redirectResponse(wallpaper: Wallpaper, head: boolean): Response {
  return new Response(head ? null : "", {
    status: 302,
    headers: commonHeaders({
      ...wallpaperHeaders(wallpaper),
      Location: wallpaper.path
    })
  });
}

function jsonResponse(
  payload: unknown,
  options: {
    status?: number;
    head?: boolean;
    headers?: HeadersInit;
  } = {}
): Response {
  const body = options.head ? null : JSON.stringify(payload, null, 2);
  return new Response(body, {
    status: options.status ?? 200,
    headers: commonHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...headersToObject(options.headers)
    })
  });
}

function textResponse(
  body: string,
  options: {
    status?: number;
    head?: boolean;
    headers?: HeadersInit;
  } = {}
): Response {
  return new Response(options.head ? null : body, {
    status: options.status ?? 200,
    headers: commonHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      ...headersToObject(options.headers)
    })
  });
}

function wallpaperHeaders(wallpaper: Wallpaper): Record<string, string> {
  return {
    "X-Wallhaven-ID": wallpaper.id,
    "X-Wallhaven-URL": wallpaper.url
  };
}

function commonHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers({
    ...CORS_HEADERS,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });

  for (const [key, value] of Object.entries(headersToObject(extra))) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return headers;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
