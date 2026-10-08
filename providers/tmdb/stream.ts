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
  link: string;
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
    return String.fromCharCode(
      ((char.charCodeAt(0) - base + 13) % 26) + base,
    );
  });

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
  const title = data.title || data.name || data.original_title || data.original_name;
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

  if (!exact && !fallback) throw new Error(`4KHDHub title not found: ${media.title}`);
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
        const link =
          $(element).find("a:contains('HubCloud')").attr("href") ||
          $(element).find("a").first().attr("href") ||
          "";
        if (link) {
          matches.push({
            link,
            label: qualityLabel(groupTitle, media.title),
          });
        }
      }
    });
    if (!matches.length) throw new Error(`4KHDHub episode not found: ${wanted}`);
    return matches;
  }

  const matches: DownloadVariant[] = [];
  $(".download-item").each((_index, element) => {
    const link =
      $(element).find("a:contains('HubCloud')").attr("href") ||
      $(element).find("a").first().attr("href") ||
      "";
    if (link) {
      matches.push({
        link,
        label: qualityLabel(
          $(element).find(".flex-1.text-left.font-semibold").text(),
          media.title,
        ),
      });
    }
  });
  if (!matches.length) throw new Error(`4KHDHub downloads not found: ${media.title}`);
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
  if (waitMs > 0) await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }, { once: true });
  });
  return blogLink;
}

async function extractHubCloud(
  link: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
  qualityLabelText?: string,
): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  const response = await axios.get(link, { headers, signal });
  const html = String(response.data);
  const $ = cheerio.load(html);
  let next =
    html.match(/(?:var|let|const)\s+\w+\s*=\s*atob\(atob\(['"]([^'"]+)['"]\)\)/)?.[1] ||
    $(".fa-file-download.fa-lg").parent().attr("href") ||
    "";
  if (next) {
    try {
      next = atob(atob(next));
    } catch {
      // Keep the original link when the page uses a non-base64 redirect.
    }
  }
  if (!next || next === link) return [];

  const cloud = await axios.get(next, { headers, signal });
  const $$ = cheerio.load(String(cloud.data));
  const streams: Stream[] = [];
  const withQuality = (server: string) =>
    qualityLabelText ? `${server} (${qualityLabelText})` : server;
  const quality = qualityLabelText?.match(/\b(360|480|720|1080|2160)p\b/i)?.[1];
  $$(".btn-success.btn-lg.h6,.btn-danger,.btn-secondary").each((_index, element) => {
    const href = $$(element).attr("href") || "";
    if (!href) return;
    if (href.includes("pixeldrain")) {
      streams.push({ server: withQuality("Pixeldrain"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    } else if (href.includes("cloudflarestorage")) {
      streams.push({ server: withQuality("CF Storage"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    } else if (href.includes("fastdl") || href.includes("fsl.")) {
      streams.push({ server: withQuality("FastDl"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    } else if (href.includes("hubcdn")) {
      streams.push({ server: withQuality("HubCdn"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    } else if (href.includes("google") || href.includes("drive")) {
      streams.push({ server: withQuality("GDrive (download only)"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    } else if (href.includes(".mkv") || href.includes("?token=")) {
      streams.push({ server: withQuality("CF Worker"), link: href, type: "mkv", ...(quality ? { quality } : {}) });
    }
  });
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
    const variants = await findDownloadLinks(page, media, providerContext, signal);
    const results = await Promise.allSettled(
      variants.map(async (variant) => {
        const resolved = await redirect4khdhub(
          variant.link,
          providerContext,
          signal,
        );
        if (resolved.includes("hubcloud") || resolved.includes("/drive/")) {
          return extractHubCloud(resolved, providerContext, signal, variant.label);
        }

        const response = await providerContext.axios.get(resolved, {
          headers: providerContext.commonHeaders,
          signal,
        });
        const html = String(response.data);
        const $ = providerContext.cheerio.load(html);
        const hubLink =
          $('h3:contains("1080p") a').attr("href") ||
          html.match(/href="(https:\/\/hubcloud\.[^"]+\/drive\/[^"]+)"/)?.[1] ||
          "";
        if (!hubLink) throw new Error("4KHDHub did not return a HubCloud link");
        return extractHubCloud(hubLink, providerContext, signal, variant.label);
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
          all.findIndex((candidate) => candidate.link === stream.link) === index,
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
