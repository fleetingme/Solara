const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const AUDIO_REFERER_BY_SOURCE: Record<string, string> = {
  kuwo: "https://www.kuwo.cn/",
  netease: "https://music.163.com/",
  joox: "https://www.joox.com/",
};

const AUDIO_HOST_WHITELIST: Record<string, RegExp[]> = {
  kuwo: [/^(?:.+\.)?kuwo\.cn$/i],
  netease: [/^(?:.+\.)?music\.126\.net$/i, /^(?:.+\.)?music\.163\.com$/i, /^(?:.+\.)?163\.com$/i],
  joox: [/^(?:.+\.)?joox\.com$/i, /^(?:.+\.)?jooxcdn\.com$/i, /^(?:.+\.)?qqmusic\.qq\.com$/i, /^(?:.+\.)?stream\.qqmusic\.qq\.com$/i],
};

const DEFAULT_ALLOWED_HOSTS: RegExp[] = ([] as RegExp[]).concat(...Object.values(AUDIO_HOST_WHITELIST));
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedAudioHost(hostname: string, source?: string | null): boolean {
  if (!hostname) {
    return false;
  }

  const normalizedSource = (source ?? "").toLowerCase();
  const patterns = AUDIO_HOST_WHITELIST[normalizedSource] ?? DEFAULT_ALLOWED_HOSTS;
  return patterns.some(pattern => pattern.test(hostname));
}

function normalizeTargetUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveAudioReferer(source: string | null, hostname: string): string | null {
  const normalizedSource = (source ?? "").toLowerCase();
  if (normalizedSource && AUDIO_REFERER_BY_SOURCE[normalizedSource]) {
    return AUDIO_REFERER_BY_SOURCE[normalizedSource];
  }

  const matchedSource = Object.entries(AUDIO_HOST_WHITELIST).find(([, patterns]) =>
    patterns.some(pattern => pattern.test(hostname))
  );

  if (!matchedSource) {
    return null;
  }

  const [sourceKey] = matchedSource;
  return AUDIO_REFERER_BY_SOURCE[sourceKey] ?? null;
}

async function proxyAudioRequest(targetUrl: string, source: string | null, request: Request): Promise<Response> {
  const normalized = normalizeTargetUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  if (!isAllowedAudioHost(normalized.hostname, source)) {
    return new Response("Target host not allowed", { status: 403 });
  }

  const headers: Record<string, string> = {
    "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
  };

  const referer = resolveAudioReferer(source, normalized.hostname);
  if (referer) {
    headers["Referer"] = referer;
    try {
      headers["Origin"] = new URL(referer).origin;
    } catch {
      // ignore malformed referer origins
    }
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    headers["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), {
    method: request.method,
    headers,
  });

  const responseHeaders = createCorsHeaders(upstream.headers);
  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  const apiUrl = new URL(API_BASE_URL);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  const source = url.searchParams.get("source");

  if (target) {
    return proxyAudioRequest(target, source, request);
  }

  return proxyApiRequest(url, request);
}
