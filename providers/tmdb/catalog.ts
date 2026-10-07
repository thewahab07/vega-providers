import { Catalog } from "../types";

/**
 * A `filter` is a TMDB v3 path, optionally with a query string.
 * posts.ts appends the page, language and api key automatically.
 * Tokens {today}, {weekAgo} and {monthAgo} are replaced with ISO dates.
 */

const ANIME = "with_genres=16&with_original_language=ja";

export const catalog: Catalog[] = [
  { title: "Trending Today", filter: "/trending/all/day" },
  { title: "Trending This Week", filter: "/trending/all/week" },

  // Movies
  { title: "Popular Movies", filter: "/movie/popular" },
  { title: "Top Rated Movies", filter: "/movie/top_rated" },
  { title: "Now Playing in Theaters", filter: "/movie/now_playing" },
  { title: "Upcoming Movies", filter: "/movie/upcoming" },

  // TV
  { title: "Popular TV Shows", filter: "/tv/popular" },
  { title: "Top Rated TV Shows", filter: "/tv/top_rated" },
  { title: "On The Air", filter: "/tv/on_the_air" },

  // Anime
  {
    title: "Popular Anime",
    filter: `/discover/tv?${ANIME}&sort_by=popularity.desc`,
  },
  {
    title: "Airing Anime This Week",
    filter: `/discover/tv?${ANIME}&air_date.gte={weekAgo}&air_date.lte={today}&sort_by=popularity.desc`,
  },
  {
    title: "Top Rated Anime",
    filter: `/discover/tv?${ANIME}&sort_by=vote_average.desc&vote_count.gte=200`,
  },
  {
    title: "Anime Movies",
    filter: `/discover/movie?${ANIME}&sort_by=popularity.desc`,
  },

  // Regional
  {
    title: "Korean Dramas",
    filter:
      "/discover/tv?with_original_language=ko&with_genres=18&sort_by=popularity.desc",
  },

  // Networks / platforms
  {
    title: "Netflix",
    filter: "/discover/tv?with_networks=213&sort_by=popularity.desc",
  },
  {
    title: "Disney+",
    filter: "/discover/tv?with_networks=2739&sort_by=popularity.desc",
  },
  {
    title: "Prime Video",
    filter: "/discover/tv?with_networks=1024&sort_by=popularity.desc",
  },
  {
    title: "Apple TV+",
    filter: "/discover/tv?with_networks=2552&sort_by=popularity.desc",
  },
  {
    title: "HBO",
    filter: "/discover/tv?with_networks=49&sort_by=popularity.desc",
  },
];

// TMDB uses different genre ids for movies and TV, so they are listed separately.
const movieGenres: [string, number][] = [
  ["Action", 28],
  ["Adventure", 12],
  ["Animation", 16],
  ["Comedy", 35],
  ["Crime", 80],
  ["Documentary", 99],
  ["Drama", 18],
  ["Family", 10751],
  ["Fantasy", 14],
  ["History", 36],
  ["Horror", 27],
  ["Music", 10402],
  ["Mystery", 9648],
  ["Romance", 10749],
  ["Science Fiction", 878],
  ["TV Movie", 10770],
  ["Thriller", 53],
  ["War", 10752],
  ["Western", 37],
];

const tvGenres: [string, number][] = [
  ["Action & Adventure", 10759],
  ["Animation", 16],
  ["Comedy", 35],
  ["Crime", 80],
  ["Documentary", 99],
  ["Drama", 18],
  ["Family", 10751],
  ["Kids", 10762],
  ["Mystery", 9648],
  ["News", 10763],
  ["Reality", 10764],
  ["Sci-Fi & Fantasy", 10765],
  ["Soap", 10766],
  ["Talk", 10767],
  ["War & Politics", 10768],
  ["Western", 37],
];

// Genre ids are AND-ed with Animation (16) and Japanese language.
const animeGenres: [string, number][] = [
  ["Action & Adventure", 10759],
  ["Comedy", 35],
  ["Drama", 18],
  ["Sci-Fi & Fantasy", 10765],
  ["Mystery", 9648],
  ["Crime", 80],
];

export const genres: Catalog[] = [
  ...movieGenres.map(([name, id]) => ({
    title: `${name} Movies`,
    filter: `/discover/movie?with_genres=${id}&sort_by=popularity.desc`,
  })),
  ...tvGenres.map(([name, id]) => ({
    title: `${name} TV Shows`,
    filter: `/discover/tv?with_genres=${id}&sort_by=popularity.desc`,
  })),
  ...animeGenres.map(([name, id]) => ({
    title: `Anime ${name}`,
    filter: `/discover/tv?with_genres=16,${id}&with_original_language=ja&sort_by=popularity.desc`,
  })),
];
