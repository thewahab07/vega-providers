import { ProviderContext, SkipInterval } from "../types";

// TheIntroDB: community database of intro / recap / credits timestamps,
// keyed by TMDB id. Docs: https://theintrodb.org
const INTRODB_BASE = "https://api.theintrodb.org/v3";

// [key in API response, title shown in the app -> button reads "Skip <title>"]
const SEGMENTS: [string, string][] = [
  ["recap", "Recap"],
  ["intro", "Intro"],
  ["credits", "Credits"],
  ["preview", "Preview"],
];

/**
 * Fetches skip intervals (in seconds) for a movie or a single TV episode.
 * Never throws: no data / network problems simply mean "no skip button".
 *
 * `runtimeMinutes` (from TMDB) is used as the end of "credits" segments,
 * because TheIntroDB stores those as "until the end of the media".
 */
export async function getSkipIntervals(
  providerContext: ProviderContext,
  tmdbId: string | number,
  season?: number | string,
  episode?: number | string,
  runtimeMinutes?: number,
  signal?: AbortSignal,
): Promise<SkipInterval[]> {
  try {
    let url = `${INTRODB_BASE}/media?tmdb_id=${encodeURIComponent(String(tmdbId))}`;
    if (season !== undefined && episode !== undefined) {
      url += `&season=${season}&episode=${episode}`;
    }

    const response = await providerContext.axios.get(url, {
      signal,
      timeout: 6000,
    });
    const data = response.data || {};

    const durationSec =
      runtimeMinutes && runtimeMinutes > 0 ? runtimeMinutes * 60 : 0;
    const intervals: SkipInterval[] = [];

    SEGMENTS.forEach(([key, title]) => {
      const list = Array.isArray(data[key]) ? data[key] : [];
      list.forEach((segment: any) => {
        // null start = beginning of media, null end = end of media
        const from =
          typeof segment.start_ms === "number" ? segment.start_ms / 1000 : 0;
        const to =
          typeof segment.end_ms === "number"
            ? segment.end_ms / 1000
            : durationSec;

        if (from >= 0 && to - from >= 1) {
          intervals.push({ title, from, to });
        }
      });
    });

    return intervals.sort((a, b) => a.from - b.from);
  } catch {
    return [];
  }
}

/** Runs `fn` over `items` a few at a time so we don't flood the API. */
export async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}
