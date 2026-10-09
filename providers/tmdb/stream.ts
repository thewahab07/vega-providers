import { Stream, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { getBaseUrl } from "../getBaseUrl";
import { tmdbGet } from "./api";

type Media = {
  title: string;
  year?: string;
  season?: number;
  episode?: number;
};

type DownloadVariant = {
  links: string[];
  label: string;
};

const cleanTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const decodeBase64 = (value: string): string | null => {
  try {
    return atob(value);
  } catch {
    return null;
  }
};

const rot13 = (value: string) =>
  value.replace(/[a-z]/gi, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });

function getPixeldrainRedirect(...htmlSources: string[]): string {
  for (const html of htmlSources) {
    const match = html.match(/var\s+pxl\s*=\s*['"]([^'"]+)['"];?/i);
    if (match?.[1]) return match[1];
  }
  return "";
}

function normalizePixeldrainUrl(
  link: string,
  ...htmlSources: string[]
): string {
  let resolved = getPixeldrainRedirect(...htmlSources) || link;
  if (resolved.includes("/api/")) return resolved;

  try {
    const url = new URL(resolved);
    const token = url.pathname.split("/").filter(Boolean).pop();
    if (token && /pixeldrain\./i.test(url.hostname)) {
      return `${url.origin}/api/file/${token}?download`;
    }
  } catch {
    // Return the original URL when Pixeldrain sends an unusual URL format.
  }
  return resolved;
}

function workerServerName(link: string): string {
  try {
    const host = new URL(link).hostname
      .replace(/\.workers\.dev$/i, "")
      .split(".")[0];
    return host ? `CF Worker [${host}]` : "CF Worker";
  } catch {
    return "CF Worker";
  }
}

function decodeSource(value: string): { o?: string } | null {
  try {
    const first = decodeBase64(value);
    const second = first && decodeBase64(first);
    const third = second && decodeBase64(rot13(second));
    return third ? JSON.parse(third) : null;
  } catch {
    return null;
  }
}

async function tmdbMedia(
  link: string,
  providerContext: ProviderContext,
): Promise<Media> {
  const movie = /^movie\/(\d+)$/.exec(link);
  const episode = /^tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)$/.exec(link);
  const show = /^tv\/(\d+)$/.exec(link);
  if (!movie && !episode && !show) {
    throw new Error(`invalid TMDB stream link "${link}"`);
  }

  const type = movie ? "movie" : "tv";
  const id = (movie || episode || show)![1];
  const data = await tmdbGet<any>(providerContext, `/${type}/${id}`, {});
  const title =
    data.title || data.name || data.original_title || data.original_name;
  const releaseDate = data.release_date || data.first_air_date || "";
  if (!title) throw new Error(`TMDB title missing for ${link}`);

  return {
    title,
    year: releaseDate.slice(0, 4),
    ...(episode
      ? { season: Number(episode[2]), episode: Number(episode[3]) }
      : {}),
  };
}

async function find4khdhubPage(
  media: Media,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = await getBaseUrl("4khdhub");
  const query = encodeURIComponent(media.title);
  const response = await providerContext.axios.get(`${baseUrl}/?s=${query}`, {
    headers: providerContext.commonHeaders,
    signal,
  });
  const $ = providerContext.cheerio.load(response.data);
  const candidates = $(".card-grid").children("a.movie-card");
  let fallback = "";
  let exact = "";

  candidates.each((_index, element) => {
    const href = $(element).attr("href");
    const resultTitle = $(element).find(".movie-card-title").text().trim();
    if (!href || !resultTitle) return;
    const result = cleanTitle(resultTitle);
    const wanted = cleanTitle(media.title);
    const yearMatches = !media.year || result.includes(media.year);
    if (!fallback) fallback = new URL(href, `${baseUrl}/`).href;
    if (result.includes(wanted) && yearMatches && !exact) {
      exact = new URL(href, `${baseUrl}/`).href;
    }
  });

  if (!exact && !fallback)
    throw new Error(`4KHDHub title not found: ${media.title}`);
  return exact || fallback;
}

function qualityLabel(raw: string, mediaTitle: string): string {
  const firstLine = raw.replace(/\s+/g, " ").trim().split("\n")[0].trim();
  const inParentheses = firstLine.match(/\(([^()]*)\)/)?.[1];
  const label = inParentheses || firstLine;
  return label
    .replace(new RegExp(`^${cleanTitle(mediaTitle)}\\s*`, "i"), "")
    .replace(/^S\d+\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function findDownloadLinks(
  pageUrl: string,
  media: Media,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<DownloadVariant[]> {
  const response = await providerContext.axios.get(pageUrl, {
    headers: providerContext.commonHeaders,
    signal,
  });
  const $ = providerContext.cheerio.load(response.data);

  if (media.episode !== undefined && media.season !== undefined) {
    const wanted = `S${String(media.season).padStart(2, "0")}E${String(
      media.episode,
    ).padStart(2, "0")}`;
    const matches: DownloadVariant[] = [];
    $(".episode-download-item").each((_index, element) => {
      const title = $(element).find(".episode-file-title").text().toUpperCase();
      if (title.includes(wanted)) {
        const groupTitle =
          $(element).closest(".season-item").find(".episode-title").text() ||
          $(element).find(".episode-file-title").text();
        const links = $(element)
          .find("a")
          .map((_index, anchor) => {
            const href = $(anchor).attr("href") || "";
            const text = $(anchor).text().toLowerCase();
            return href &&
              (text.includes("hubcloud") || text.includes("hubdrive"))
              ? href
              : "";
          })
          .get()
          .filter(Boolean);
        if (links.length) {
          matches.push({
            links,
            label: qualityLabel(groupTitle, media.title),
          });
        }
      }
    });
    if (!matches.length)
      throw new Error(`4KHDHub episode not found: ${wanted}`);
    return matches;
  }

  const matches: DownloadVariant[] = [];
  $(".download-item").each((_index, element) => {
    const links = $(element)
      .find("a")
      .map((_index, anchor) => {
        const href = $(anchor).attr("href") || "";
        const text = $(anchor).text().toLowerCase();
        return href && (text.includes("hubcloud") || text.includes("hubdrive"))
          ? href
          : "";
      })
      .get()
      .filter(Boolean);
    if (links.length) {
      matches.push({
        links,
        label: qualityLabel(
          $(element).find(".flex-1.text-left.font-semibold").text(),
          media.title,
        ),
      });
    }
  });
  if (!matches.length)
    throw new Error(`4KHDHub downloads not found: ${media.title}`);
  return matches;
}

async function redirect4khdhub(
  link: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const { axios, commonHeaders: headers } = providerContext;
  const response = await axios.get(link, { headers, signal });
  const source = String(response.data);
  const encrypted = source.split("s('o','")?.[1]?.split("',180")?.[0];
  const decoded = encrypted ? decodeSource(encrypted) : null;
  const target = decoded?.o ? decodeBase64(decoded.o) : null;
  if (!target) return link;

  const targetResponse = await axios.get(target, { headers, signal });
  const targetText = String(targetResponse.data);
  const pieces = [...targetText.matchAll(/ck\('_wp_http_\d+','([^']+)'/g)]
    .map((match) => match[1])
    .join("");
  if (!pieces) return target;

  const step1 = decodeBase64(pieces);
  const step2 = step1 && decodeBase64(step1);
  if (!step2) return target;
  const data = JSON.parse(decodeBase64(rot13(step2)) || "{}");
  const token = btoa(String(data.data || ""));
  const blogLink = `${data.wp_http1}?re=${token}`;
  const waitMs = (Number(data.total_time) + 3) * 1000;
  if (waitMs > 0)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        },
        { once: true },
      );
    });
  return blogLink;
}

function extractHubCloudUrl(html: string, $: any): string {
  const doubleAtob = html.match(
    /(?:var|let|const)\s+\w+\s*=\s*atob\(atob\(['"]([^'"]+)['"]\)\)/,
  )?.[1];
  if (doubleAtob) {
    try {
      return atob(atob(doubleAtob));
    } catch {
      // Fall through to the other strategies.
    }
  }
  const plain = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (plain) {
    const encoded = plain.split("r=")[1];
    const decoded = encoded ? decodeBase64(encoded) : null;
    if (decoded) return decoded;
    return plain;
  }
  return $(".fa-file-download.fa-lg").parent().attr("href") || "";
}

// GET a page; when a Cloudflare challenge answers 403, solve it through the
// app's web view (when available) and retry once.
async function getWithWaf(
  url: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const { axios, openWebView, commonHeaders } = providerContext;
  const headers: Record<string, string> = { ...commonHeaders };
  try {
    return String((await axios.get(url, { headers, signal })).data);
  } catch (error: any) {
    if (error?.response?.status !== 403 || !openWebView) throw error;
    const origin = url.split("/").slice(0, 3).join("/");
    const solved = await openWebView(origin, {
      title: "Solve the captcha below and click done",
      description: "Required to bypass anti-bot protection.",
      headers: { ...headers, Referer: origin },
      waitForCookie: "cf_clearance",
      force: true,
    });
    if (solved?.userAgent) headers["User-Agent"] = solved.userAgent;
    if (solved?.cookies) {
      headers["Cookie"] = headers["Cookie"]
        ? `${headers["Cookie"]}; ${solved.cookies}`
        : solved.cookies;
    }
    return String((await axios.get(url, { headers, signal })).data);
  }
}

// HubCloud buttons point at an intermediate page that redirects (sometimes
// twice) to the real file URL. Follow the whole chain, like the upstream
// hubcloud extractor does, instead of stopping after the first hop.
async function resolveHubCloudRedirect(
  href: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const { axios, commonHeaders: headers } = providerContext;
  const stripLink = (value: string) =>
    value.includes("?link=") ? value.split("?link=")[1] || value : value;
  const absoluteUrl = (location: string, base: string) => {
    try {
      return new URL(location, base).href;
    } catch {
      return location;
    }
  };
  let current = href;

  // 1. Let fetch follow every redirect (works in the app's web worker).
  try {
    if (typeof fetch !== "undefined") {
      const res = await fetch(href, { headers, signal, redirect: "follow" });
      const finalUrl = res.url;
      try {
        await res.body?.cancel();
      } catch {
        // The body is not needed, only the final URL.
      }
      if (finalUrl && finalUrl.includes("googleusercontent")) {
        return stripLink(finalUrl);
      }
      if (finalUrl && finalUrl !== href) current = finalUrl;
    }
  } catch {
    // Fall back to manual hops below.
  }

  // 2. Manual hops (Node / environments where fetch can't expose the URL).
  if (!current.includes("googleusercontent")) {
    try {
      const noFollow = {
        headers,
        signal,
        maxRedirects: 0,
        validateStatus: (status: number) => status >= 200 && status < 400,
      };
      const first = await axios.get(current, noFollow);
      const location1 = first.headers?.location;
      if (location1) current = absoluteUrl(location1, current);
      if (!current.includes("googleusercontent") && current.includes("http")) {
        const second = await axios.get(current, noFollow);
        const location2 = second.headers?.location;
        if (location2) current = absoluteUrl(location2, current);
      }
    } catch {
      // Keep the best URL found so far.
    }
  }
  return stripLink(current);
}

async function extractHubCloud(
  link: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
  qualityLabelText?: string,
): Promise<Stream[]> {
  const { cheerio } = providerContext;
  const html = await getWithWaf(link, providerContext, signal);
  const $ = cheerio.load(html);
  let next = extractHubCloudUrl(html, $);
  if (next.startsWith("/"))
    next = `${link.split("/").slice(0, 3).join("/")}${next}`;
  if (!next || next === link) return [];

  const cloudHtml = await getWithWaf(next, providerContext, signal);
  const cloud = { data: cloudHtml };
  const $$ = cheerio.load(String(cloud.data));
  const streams: Stream[] = [];
  const withQuality = (server: string) =>
    qualityLabelText ? `${server} (${qualityLabelText})` : server;
  const quality = qualityLabelText?.match(/\b(360|480|720|1080|2160)p\b/i)?.[1];
  const linkElements = $$(
    ".btn-success.btn-lg.h6,.btn-danger,.btn-secondary",
  ).toArray();
  for (const element of linkElements) {
    const href = $$(element).attr("href") || "";
    if (!href) continue;
    if (href.includes("pixeldrain")) {
      streams.push({
        server: withQuality("Pixeldrain"),
        link: normalizePixeldrainUrl(href, html, String(cloud.data)),
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (
      href.includes("hubcloud") ||
      href.includes("/?id=") ||
      href.includes("greenmotors")
    ) {
      const direct = await resolveHubCloudRedirect(
        href,
        providerContext,
        signal,
      );
      const server = direct.includes(".dev")
        ? workerServerName(direct)
        : direct.includes("google") || direct.includes("drive")
          ? "GDrive (download only)"
          : "CF Worker";
      streams.push({
        server: withQuality(server),
        link: direct,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes(".dev") && !href.includes("/?id=")) {
      streams.push({
        server: withQuality(workerServerName(href)),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes("cloudflarestorage")) {
      streams.push({
        server: withQuality("CF Storage"),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes("fastdl") || href.includes("fsl.")) {
      streams.push({
        server: withQuality("FastDl"),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes("hubcdn")) {
      streams.push({
        server: withQuality("HubCdn"),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes("google") || href.includes("drive")) {
      streams.push({
        server: withQuality("GDrive (download only)"),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    } else if (href.includes(".mkv") || href.includes("?token=")) {
      streams.push({
        server: withQuality(workerServerName(href)),
        link: href,
        type: "mkv",
        ...(quality ? { quality } : {}),
      });
    }
  }
  return streams;
}

export const getStream = async function ({
  link,
  type: _type,
  signal,
  providerContext,
  isDownload: _isDownload,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  try {
    if (link.includes("hubcloud") || link.includes("/drive/")) {
      return extractHubCloud(link, providerContext, signal);
    }

    const media = await tmdbMedia(link, providerContext);
    const page = await find4khdhubPage(media, providerContext, signal);
    const variants = await findDownloadLinks(
      page,
      media,
      providerContext,
      signal,
    );
    const results = await Promise.allSettled(
      variants.map(async (variant) => {
        let lastError: unknown;
        for (const source of variant.links) {
          try {
            const resolved = await redirect4khdhub(
              source,
              providerContext,
              signal,
            );
            if (resolved.includes("hubcloud") || resolved.includes("/drive/")) {
              const streams = await extractHubCloud(
                resolved,
                providerContext,
                signal,
                variant.label,
              );
              if (streams.length) return streams;
              throw new Error("HubCloud returned no streams");
            }

            const response = await providerContext.axios.get(resolved, {
              headers: providerContext.commonHeaders,
              signal,
            });
            const html = String(response.data);
            const $ = providerContext.cheerio.load(html);
            const hubLink =
              $('h3:contains("1080p") a').attr("href") ||
              html.match(
                /href="(https:\/\/hubcloud\.[^"]+\/drive\/[^"]+)"/,
              )?.[1] ||
              "";
            if (!hubLink)
              throw new Error("4KHDHub did not return a HubCloud link");
            const streams = await extractHubCloud(
              hubLink,
              providerContext,
              signal,
              variant.label,
            );
            if (streams.length) return streams;
            throw new Error("HubCloud returned no streams");
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error("No links for 4KHDHub variant");
      }),
    );
    const streams = results
      .filter(
        (result): result is PromiseFulfilledResult<Stream[]> =>
          result.status === "fulfilled",
      )
      .flatMap((result) => result.value);
    if (streams.length) {
      return streams.filter(
        (stream, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.link === stream.link &&
              candidate.server === stream.server,
          ) === index,
      );
    }
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw failure?.reason || new Error("No 4KHDHub streams were resolved");
  } catch (error) {
    throwProviderError("TMDB/4KHDHub", "stream", error);
  }
};
