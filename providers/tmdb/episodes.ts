import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { PROVIDER_NAME, getSettings, imageUrl, tmdbGet } from "./api";
import { getSkipIntervals, mapInBatches } from "./skips";

// Each episode needs one TheIntroDB request, so cap very long seasons.
const MAX_SKIP_LOOKUPS = 100;
const SKIP_BATCH_SIZE = 8;

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  // url looks like "tv/1399/season/1" (set as `episodesLink` in meta.ts)
  const match = /tv\/(\d+)\/season\/(\d+)/.exec(url || "");
  if (!match) {
    throw new Error(`${PROVIDER_NAME} getEpisodes failed: invalid url "${url}"`);
  }

  const [, showId, seasonNumber] = match;

  try {
    const data = await tmdbGet<any>(
      providerContext,
      `/tv/${showId}/season/${seasonNumber}`,
    );

    const today = new Date().toISOString().slice(0, 10);
    const settings = await getSettings(providerContext);

    const episodes: EpisodeLink[] = (data.episodes || []).map((episode: any): EpisodeLink => {
      const number = episode.episode_number;
      const name: string = (episode.name || "").trim();
      const isGenericName =
        !name ||
        name === String(number) ||
        new RegExp(`^episode\\s*${number}$`, "i").test(name);

      const airDate: string = episode.air_date || "";
      const notAired = !!airDate && airDate > today;
      const overview: string = (episode.overview || "").trim();

      const result: EpisodeLink = {
        title: isGenericName
          ? `Episode ${number}`
          : `Episode ${number} - ${name}`,
        link: `tv/${showId}/season/${seasonNumber}/episode/${number}`,
      };

      const description = notAired
        ? `Airs ${airDate}${overview ? `. ${overview}` : ""}`
        : overview || (airDate ? `Aired ${airDate}` : "");
      if (description) result.description = description;

      const image = imageUrl(episode.still_path, "w300");
      if (image) result.image = image;

      return result;
    });

    if (settings.skipTimings) {
      // Only aired episodes can have timings.
      const airedNumbers = (data.episodes || [])
        .filter((e: any) => !e.air_date || e.air_date <= today)
        .slice(0, MAX_SKIP_LOOKUPS);

      const skips = await mapInBatches(
        airedNumbers,
        SKIP_BATCH_SIZE,
        (e: any) =>
          getSkipIntervals(
            providerContext,
            showId,
            seasonNumber,
            e.episode_number,
            e.runtime,
          ),
      );

      airedNumbers.forEach((e: any, index: number) => {
        const target = episodes.find(
          (ep) =>
            ep.link ===
            `tv/${showId}/season/${seasonNumber}/episode/${e.episode_number}`,
        );
        if (target && skips[index].length) target.skip = skips[index];
      });
    }

    return episodes;
  } catch (error) {
    throwProviderError(PROVIDER_NAME, "getEpisodes", error);
  }
};
