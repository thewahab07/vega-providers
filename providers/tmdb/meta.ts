import { Info, Link, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  PROVIDER_NAME,
  getSettings,
  imageUrl,
  makeLink,
  parseLink,
  tmdbGet,
} from "./api";
import { getSkipIntervals } from "./skips";

function formatRuntime(minutes?: number): string {
  if (!minutes || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins}m`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Picks the best title logo (PNG/JPG only, React Native can't draw SVG). */
function pickLogo(logos: any[] | undefined, language: string): string {
  const usable = (logos || []).filter((logo) =>
    /\.(png|jpe?g)$/i.test(logo.file_path || ""),
  );
  if (!usable.length) return "";

  const lang = language.split("-")[0];
  const best =
    usable.find((logo) => logo.iso_639_1 === lang) ||
    usable.find((logo) => logo.iso_639_1 === "en") ||
    usable.find((logo) => !logo.iso_639_1) ||
    usable[0];

  return imageUrl(best.file_path, "w500");
}

function pickTrailer(videos: any[] | undefined): string {
  const youtube = (videos || []).filter(
    (video) => video.site === "YouTube" && video.key,
  );
  const best =
    youtube.find((video) => video.type === "Trailer" && video.official) ||
    youtube.find((video) => video.type === "Trailer") ||
    youtube.find((video) => video.type === "Teaser") ||
    youtube[0];

  return best ? `https://www.youtube.com/watch?v=${best.key}` : "";
}

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  const parsed = parseLink(link);
  if (!parsed) {
    throw new Error(`${PROVIDER_NAME} getMeta failed: invalid link "${link}"`);
  }

  const { type, id } = parsed;
  const isMovie = type === "movie";

  try {
    const settings = await getSettings(providerContext);
    const imageLanguages = `${settings.language.split("-")[0]},en,null`;

    const data = await tmdbGet<any>(providerContext, `/${type}/${id}`, {
      append_to_response: "external_ids,credits,images,videos",
      include_image_language: imageLanguages,
      include_video_language: imageLanguages,
    });

    // Many anime / regional titles have no overview in the chosen language,
    // so fall back to English.
    let synopsis: string = data.overview || "";
    if (!synopsis && settings.language !== "en-US") {
      try {
        const english = await tmdbGet<any>(
          providerContext,
          `/${type}/${id}`,
          {},
          undefined,
          { language: "en-US" },
        );
        synopsis = english.overview || "";
      } catch {
        // keep the empty synopsis
      }
    }

    const title: string =
      data.title || data.name || data.original_title || data.original_name;
    const releaseDate: string = data.release_date || data.first_air_date || "";
    const year = releaseDate ? releaseDate.slice(0, 4) : "";

    const runtime = isMovie
      ? formatRuntime(data.runtime)
      : data.number_of_seasons
        ? `${data.number_of_seasons} Season${data.number_of_seasons > 1 ? "s" : ""}`
        : "";

    const genres: string[] = (data.genres || []).map((genre: any) => genre.name);
    const cast: string[] = ((data.credits && data.credits.cast) || [])
      .slice(0, 15)
      .map((person: any) => person.name)
      .filter(Boolean);

    const poster = imageUrl(data.poster_path, "w780");
    const backdrop = imageUrl(data.backdrop_path, "w1280");

    const imdbId: string =
      data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || "";

    const rating =
      typeof data.vote_average === "number" && data.vote_count > 0
        ? data.vote_average.toFixed(1)
        : undefined;

    // The app shows these chips under the title: year, length, genres.
    const tags = [year, runtime, ...genres].filter(Boolean);

    const linkList: Link[] = [];

    if (isMovie) {
      const skip = settings.skipTimings
        ? await getSkipIntervals(providerContext, id, undefined, undefined, data.runtime)
        : [];

      linkList.push({
        title,
        directLinks: [
          {
            title: "Movie",
            link: makeLink("movie", id),
            type: "movie",
            ...(skip.length ? { skip } : {}),
          },
        ],
      });
    } else {
      // One entry per season; the app calls getEpisodes (episodes.ts) with
      // `episodesLink` when the user picks a season.
      (data.seasons || [])
        .filter((season: any) => (season.episode_count || 0) > 0)
        .forEach((season: any) => {
          linkList.push({
            title:
              season.name ||
              (season.season_number === 0
                ? "Specials"
                : `Season ${season.season_number}`),
            episodesLink: `tv/${id}/season/${season.season_number}`,
          });
        });
    }

    const info: Info = {
      title,
      synopsis: synopsis || "No synopsis available.",
      image: backdrop || poster,
      poster: poster || backdrop,
      imdbId,
      tmdbId: String(data.id || id),
      type: isMovie ? "movie" : "series",
      tags,
      cast,
      linkList,
      webUrl: `https://www.themoviedb.org/${type}/${id}`,
    };

    const logo = pickLogo(data.images && data.images.logos, settings.language);
    if (logo) info.logo = logo;
    if (rating) info.rating = rating;

    const trailerUrl = pickTrailer(data.videos && data.videos.results);
    if (trailerUrl) info.trailerUrl = trailerUrl;

    return info;
  } catch (error) {
    throwProviderError(PROVIDER_NAME, "getMeta", error);
  }
};
