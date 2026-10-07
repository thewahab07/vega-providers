import { Post, ProviderContext } from "../types";

export const PROVIDER_NAME = "tmdb";

const API_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

// Injected at build time from .env (see build-bundled.js). Users can still
// override it from the provider settings in the app.
const DEFAULT_API_KEY = process.env.TMDB_API_KEY || "";
const DEFAULT_LANGUAGE = "en-US";

export type MediaType = "movie" | "tv";

export interface TmdbSettings {
  apiKey: string;
  language: string;
  region: string;
  includeAdult: boolean;
}

// ---------------------------------------------------------------------------
// Settings (stored by the app in providerContext.kvStore, see settings.ts)
// ---------------------------------------------------------------------------

async function readSetting<T>(
  providerContext: ProviderContext,
  key: string,
): Promise<T | undefined> {
  try {
    // kvStore is not available in every test harness, so stay defensive.
    if (!providerContext.kvStore) return undefined;
    return await providerContext.kvStore.get<T>(key);
  } catch {
    return undefined;
  }
}

export async function getSettings(
  providerContext: ProviderContext,
): Promise<TmdbSettings> {
  const apiKey = await readSetting<string>(providerContext, "apiKey");
  const language = await readSetting<string>(providerContext, "language");
  const region = await readSetting<string>(providerContext, "region");
  const includeAdult = await readSetting<boolean>(
    providerContext,
    "includeAdult",
  );

  const cleanRegion = (region || "").trim().toUpperCase();

  return {
    apiKey: (apiKey || "").trim() || DEFAULT_API_KEY,
    language: /^[a-z]{2}(-[A-Z]{2})?$/.test(language || "")
      ? (language as string)
      : DEFAULT_LANGUAGE,
    region: /^[A-Z]{2}$/.test(cleanRegion) ? cleanRegion : "",
    includeAdult: includeAdult === true,
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type QueryValue = string | number | boolean | undefined | null;

function buildQuery(params: Record<string, QueryValue>): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .filter((key) => params[key] !== "")
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`,
    )
    .join("&");
}

/**
 * Replaces date tokens that catalog filters can use, so "this week" style
 * lists stay current without rebuilding the provider.
 */
function applyDateTokens(input: string): string {
  const day = 24 * 60 * 60 * 1000;
  const iso = (offset: number) =>
    new Date(Date.now() + offset * day).toISOString().slice(0, 10);

  return input
    .replace(/\{today\}/g, iso(0))
    .replace(/\{weekAgo\}/g, iso(-7))
    .replace(/\{monthAgo\}/g, iso(-30));
}

/**
 * GET a TMDB v3 endpoint.
 * `path` may already contain a query string (e.g. "/discover/tv?with_genres=16").
 */
export async function tmdbGet<T = any>(
  providerContext: ProviderContext,
  path: string,
  params: Record<string, QueryValue> = {},
  signal?: AbortSignal,
  settingsOverride?: Partial<TmdbSettings>,
): Promise<T> {
  const settings = { ...(await getSettings(providerContext)), ...settingsOverride };

  const cleanPath = applyDateTokens(path.startsWith("/") ? path : `/${path}`);
  const isListing =
    cleanPath.startsWith("/discover") || cleanPath.startsWith("/search");

  const query = buildQuery({
    api_key: settings.apiKey,
    language: settings.language,
    region: settings.region || undefined,
    include_adult: isListing ? settings.includeAdult : undefined,
    ...params,
  });

  const separator = cleanPath.includes("?") ? "&" : "?";
  const url = `${API_BASE}${cleanPath}${separator}${query}`;

  const response = await providerContext.axios.get(url, { signal });
  return response.data as T;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const imageUrl = (
  path: string | null | undefined,
  size: string,
): string => (path ? `${IMAGE_BASE}/${size}${path}` : "");

// ---------------------------------------------------------------------------
// Links  ("movie/603", "tv/1399")
// ---------------------------------------------------------------------------

export const makeLink = (type: MediaType, id: number | string): string =>
  `${type}/${id}`;

export function parseLink(
  link: string,
): { type: MediaType; id: string } | null {
  const match = /(movie|tv)\/(\d+)/.exec(link || "");
  if (!match) return null;
  return { type: match[1] as MediaType, id: match[2] };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * Converts a raw TMDB list/search item into a Post.
 * Returns null for people and for items with no artwork.
 */
export function toPost(item: any, fallbackType?: MediaType): Post | null {
  if (!item || !item.id) return null;

  // Mixed lists (trending, multi search) carry media_type per item.
  const isMixed = !!item.media_type;
  const mediaType = (item.media_type || fallbackType) as string | undefined;
  if (mediaType !== "movie" && mediaType !== "tv") return null;

  const image =
    imageUrl(item.poster_path, "w500") ||
    imageUrl(item.backdrop_path, "w500");
  if (!image) return null;

  const title =
    item.title || item.name || item.original_title || item.original_name;
  if (!title) return null;

  const hasRating =
    typeof item.vote_average === "number" &&
    item.vote_average > 0 &&
    (item.vote_count || 0) >= 5;
  const rating = hasRating ? `★ ${item.vote_average.toFixed(1)}` : "";
  const kind = isMixed && mediaType === "tv" ? "TV" : "";
  const cornerTag = [kind, rating].filter(Boolean).join(" ");

  const post: Post = {
    title,
    link: makeLink(mediaType, item.id),
    image,
  };
  if (cornerTag) post.cornerTag = cornerTag;
  return post;
}

/** Guess the media type of a list endpoint from its path. */
export function inferTypeFromPath(path: string): MediaType | undefined {
  if (/\/movie(\/|\?|$)/.test(path)) return "movie";
  if (/\/tv(\/|\?|$)/.test(path)) return "tv";
  return undefined;
}
