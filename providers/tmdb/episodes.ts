import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { PROVIDER_NAME, imageUrl, tmdbGet } from "./api";

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

    return (data.episodes || []).map((episode: any): EpisodeLink => {
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
  } catch (error) {
    throwProviderError(PROVIDER_NAME, "getEpisodes", error);
  }
};
