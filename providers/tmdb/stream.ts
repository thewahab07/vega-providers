import { Stream, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { getBaseUrl } from "../getBaseUrl";
import { tmdbGet } from "./api";

type Media = {
  title: string;
  originalTitle?: string;
  isTv?: boolean;
  year?: string;
  season?: number;
  episode?: number;
};

type DownloadVariant = {
  links: string[];
  label: string;
  size?: string;
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

const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)/i;

// "2.1gb" / "750 MB" -> "2.1 GB" / "750 MB"
function parseSize(text: string): string | undefined {
  const match = text.match(SIZE_PATTERN);
  if (!match) return undefined;
  return `${match[1].replace(",", ".")} ${match[2].toUpperCase()}`;
}

function stripSize(text: string): string {
  return text
    .replace(new RegExp(SIZE_PATTERN.source, "gi"), "")
    .replace(/\[\s*\]|\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    originalTitle: data.original_title || data.original_name || undefined,
    isTv: type === "tv",
    year: releaseDate.slice(0, 4),
    ...(episode
      ? { season: Number(episode[2]), episode: Number(episode[3]) }
      : {}),
  };
}

const COLLECTION_PATTERN =
  /\b(collection|trilogy|duology|quadrilogy|saga|anthology|franchise|box\s*set|vol(?:ume)?s?\.?\s*\d+\s*[-–&+]\s*\d+)\b/i;

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "part"]);

const titleTokens = (value: string) =>
  cleanTitle(value.replace(/&/g, " and "))
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));

// Cards look like: <title> <year> • <season tag> <quality / genre labels>.
// The site does NOT put the year inside the title, and the URL tells a series
// ("...-series-149") from a movie ("...-movie-3546").
type Candidate = { href: string; title: string; year?: number; isTv?: boolean };

// 0 = reject. Higher is better. Title match is the main signal; type and year
// separate remakes / sequels / same-named titles from the right one.
function scoreCandidate(candidate: Candidate, media: Media): number {
  const wantedTokens = [media.title, media.originalTitle]
    .filter((name): name is string => !!name)
    .map(titleTokens);
  const cleanedTitle = candidate.title
    .replace(/[\[(].*?[\])]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const have = titleTokens(cleanedTitle);
  if (!have.length) return 0;

  // A film must not be matched to a series page, or the other way round.
  if (candidate.isTv !== undefined && candidate.isTv !== !!media.isTv) return 0;
  if (!media.isTv && COLLECTION_PATTERN.test(candidate.title)) return 0;

  // 2 = same title, 1 = related title. The site often adds a franchise tag
  // ("Guardians of the Galaxy Marvel Phase 2"), so a title that contains all
  // the wanted words (or the reverse) counts, but only if the year then
  // confirms it is the same film.
  let titleScore = 0;
  let extraWords = 0;
  for (const want of wantedTokens) {
    if (!want.length) continue;
    if (want.join(" ") === have.join(" ")) {
      titleScore = 2;
      extraWords = 0;
      break;
    }
    const wantInHave = want.every((token) => have.includes(token));
    const haveInWant = have.every((token) => want.includes(token));
    const shared = want.filter((token) => have.includes(token)).length;
    if (
      wantInHave ||
      haveInWant ||
      shared / Math.max(want.length, have.length) >= 0.6
    ) {
      if (titleScore < 1) {
        titleScore = 1;
        extraWords = Math.abs(have.length - want.length);
      }
    }
  }
  if (!titleScore) return 0;

  const wantedYear = Number(media.year);
  let yearScore = 1; // site shows no year: unknown
  if (wantedYear && candidate.year) {
    const diff = Math.abs(candidate.year - wantedYear);
    if (diff === 0) yearScore = 3;
    else if (diff === 1) yearScore = 2;
    // A different year is a different film (sequel / remake). For series the
    // card shows the first year, which can differ from TMDB's air date, but
    // only an exact title match is trusted then.
    else if (media.isTv && titleScore === 2) yearScore = 1;
    else return 0;
  }
  // A merely related title must be confirmed by the year.
  if (titleScore < 2 && yearScore < 2) return 0;
  return titleScore * 10 + yearScore + 1 / (1 + extraWords);
}

async function find4khdhubPage(
  media: Media,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = await getBaseUrl("4khdhub");
  const queries = [
    media.title,
    media.title.split(/\s*[:–-]\s+/)[0],
    media.originalTitle,
  ].filter(
    (query, index, all): query is string =>
      !!query && all.indexOf(query) === index,
  );

  for (const query of queries) {
    const response = await providerContext.axios.get(
      `${baseUrl}/?s=${encodeURIComponent(query)}`,
      { headers: providerContext.commonHeaders, signal },
    );
    const $ = providerContext.cheerio.load(response.data);
    let best = "";
    let bestScore = 0;
    $(".card-grid")
      .children("a.movie-card")
      .each((_index, element) => {
        const href = $(element).attr("href");
        const title = $(element)
          .find(".movie-card-title")
          .text()
          .replace(/\s+/g, " ")
          .trim();
        if (!href || !title) return;
        const rest = $(element).text().replace(/\s+/g, " ").replace(title, " ");
        const year = Number(rest.match(/\b(?:19|20)\d{2}\b/)?.[0]) || undefined;
        const kind = href.match(/-(series|movie)-\d+\/?(?:[?#].*)?$/i)?.[1];
        const score = scoreCandidate(
          {
            href,
            title,
            year,
            isTv: kind ? kind.toLowerCase() === "series" : undefined,
          },
          media,
        );
        if (score > bestScore) {
          bestScore = score;
          best = new URL(href, `${baseUrl}/`).href;
        }
      });
    if (best) return best;
  }

  // No guessing: the first search result is often a different title.
  throw new Error(`4KHDHub title not found: ${media.title}`);
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
    const wantedPattern = new RegExp(`(?<![A-Z0-9])${wanted}(?!\\d)`);
    const matches: DownloadVariant[] = [];
    // The page also holds OAD / "Final Season" files named S01Exx inside other
    // season groups, so only read files from the requested season's group.
    const groupSeason = (element: any): number | undefined => {
      const group = $(element).closest(".season-item");
      if (!group.length) return undefined;
      const header = group.clone();
      header.find(".episode-download-item").remove();
      const text = header.text().replace(/\s+/g, " ");
      const found = text.match(/\bS(?:eason)?\s*0*(\d{1,2})\b/i)?.[1];
      return found ? Number(found) : undefined;
    };
    const items = $(".episode-download-item").toArray();
    const seasonKnown = items.some((item) => groupSeason(item) !== undefined);
    $(items).each((_index, element) => {
      const title = $(element).find(".episode-file-title").text().toUpperCase();
      const season = groupSeason(element);
      if (seasonKnown && season !== media.season) return;
      if (wantedPattern.test(title)) {
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
            size: parseSize($(element).text()),
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
        size: parseSize($(element).text()),
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
  const encrypted =
    source.match(/\bs\(\s*'o'\s*,\s*'([^']+)'/)?.[1] ||
    source.split("s('o','")?.[1]?.split("',180")?.[0];
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });

const HUB_LINK_PATTERN = /hubcloud|hubdrive|\/drive\//i;

// The page behind the 4KHDHub redirect lists the HubCloud / HubDrive links.
// Older posts (e.g. Guardians of the Galaxy 1 & 2) don't always use the
// "<h3>1080p" layout, so try several strategies, best match first.
async function findHubLinkOnPage(
  pageUrl: string,
  variant: DownloadVariant,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  let html = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    html = String((await axios.get(pageUrl, { headers, signal })).data);
    if (!/Invalid Request/i.test(html)) break;
    await sleep(1500, signal);
  }
  const $ = cheerio.load(html);
  const absolute = (href?: string) => {
    if (!href) return "";
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return "";
    }
  };

  const quality = variant.label.match(/\b\d{3,4}p\b/i)?.[0] || "";
  const candidates: string[] = [
    html.match(/var\s+reurl\s*=\s*["']([^"']+)["']/)?.[1] || "",
    quality ? $(`h3:contains("${quality}") a`).attr("href") || "" : "",
    $('h3:contains("1080p") a').attr("href") || "",
    ...$("a")
      .toArray()
      .map((anchor) => $(anchor).attr("href") || "")
      .filter((href) => HUB_LINK_PATTERN.test(href)),
    ...[...html.matchAll(/href=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((href) => HUB_LINK_PATTERN.test(href)),
  ];
  for (const candidate of candidates) {
    const url = absolute(candidate);
    if (url && url !== pageUrl) return url;
  }
  throw new Error(`4KHDHub page has no HubCloud/HubDrive link (${pageUrl})`);
}

// HubDrive pages hand over to HubCloud through a button and/or a meta refresh.
async function hubDriveToHubCloud(
  link: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  if (!/hubdrive/i.test(link)) return link;
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  const html = String((await axios.get(link, { headers, signal })).data);
  const $ = cheerio.load(html);
  const next =
    $(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href") ||
    $("a")
      .toArray()
      .map((anchor) => $(anchor).attr("href") || "")
      .find((href) => /hubcloud|\/drive\//i.test(href)) ||
    link;
  const refreshed = html.match(
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i,
  )?.[1];
  const target = next !== link ? next : refreshed || link;
  try {
    return new URL(target, link).href;
  } catch {
    return target;
  }
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
  referer?: string,
): Promise<string> {
  const { axios } = providerContext;
  const headers = referer
    ? { ...providerContext.commonHeaders, Referer: referer }
    : providerContext.commonHeaders;
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
  sizeText?: string,
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
  // Prefer the size from the 4KHDHub listing; fall back to the HubCloud page.
  const size =
    sizeText ||
    parseSize(
      $.root()
        .text()
        .match(/File\s*Size\s*[:\-]?\s*[\d.,]+\s*[KMGT]B/i)?.[0] || "",
    ) ||
    parseSize(
      $$.root()
        .text()
        .match(/(?:File\s*)?Size\s*[:\-]?\s*[\d.,]+\s*[KMGT]B/i)?.[0] || "",
    );
  const label = qualityLabelText ? stripSize(qualityLabelText) : "";
  const withQuality = (server: string) => {
    const named = label ? `${server} (${label})` : server;
    return size ? `${size} • ${named}` : named;
  };
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
                variant.size,
              );
              if (streams.length) return streams;
              throw new Error("HubCloud returned no streams");
            }

            const found = await findHubLinkOnPage(
              resolved,
              variant,
              providerContext,
              signal,
            );
            const hubLink = await hubDriveToHubCloud(
              found,
              providerContext,
              signal,
            );
            const streams = await extractHubCloud(
              hubLink,
              providerContext,
              signal,
              variant.label,
              variant.size,
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
    const reasons = [
      ...new Set(
        results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) =>
            String(result.reason?.message || result.reason || "unknown error"),
          ),
      ),
    ];
    throw new Error(
      reasons.length
        ? `No streams for "${media.title}" (${page}): ${reasons.join(" | ")}`
        : "No 4KHDHub streams were resolved",
    );
  } catch (error) {
    throwProviderError("TMDB/4KHDHub", "stream", error);
  }
};
