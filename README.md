# Vega TMDB Provider

A [Vega App](https://github.com/vega-org/vega-app) provider that browses everything on
[TMDB](https://www.themoviedb.org): movies, TV shows, anime, seasons and episodes.
Catalogs and metadata come from TMDB; playback links are resolved through
[4KHDHub](https://4khdhub.one) and its HubCloud servers.

## What you get

- **Home rows:** Trending, Popular / Top Rated / Now Playing / Upcoming movies, Popular / Top Rated / On The Air TV,
  Popular / Airing This Week / Top Rated Anime, Anime Movies, K-Dramas, Netflix, Disney+, Prime Video, Apple TV+, HBO
- **Genres:** 19 movie genres, 16 TV genres, 6 anime genres
- **Search:** movies, TV and anime in one search (people are filtered out)
- **Details:** backdrop, poster, logo, synopsis, rating, cast, genres, year/runtime, trailer, IMDb + TMDB ids
- **Seasons & episodes:** every season (incl. Specials) with episode titles, descriptions and stills
- **Playback:** TMDB movie/show IDs are matched to 4KHDHub pages and resolved to HubCloud streams
- **Skip intro / recap / credits:** timestamps from [TheIntroDB](https://theintrodb.org) (matched by TMDB id) are attached to every aired episode and to movies, so the app's skip button works. Coverage is community-sourced, so some titles have none.

## Setup

```bash
npm install
npm run build        # generates dist/ – commit it, the app downloads from there
```

Push to GitHub as `YOUR_USERNAME/vega-providers`, then in the app go to
Extensions/Providers and enter your GitHub username (or the full repo URL if you named it differently).

## Settings (in the app)

| Setting                    | Purpose                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Metadata Language          | Language of titles / overviews (falls back to English when a translation is missing) |
| Region                     | Country code for release dates and Now Playing / Upcoming                            |
| Include adult content      | Off by default                                                                       |
| Skip intro / outro timings | On by default. Turn off to avoid the extra per-episode lookups                       |
| TMDB API Key               | Optional override of the built-in key (`providers/tmdb/api.ts`)                      |

## Layout

```
providers/tmdb/
  api.ts        TMDB requests, settings, image URLs, post mapping
  catalog.ts    home rows + genres (a filter is a TMDB path, e.g. "/discover/tv?with_genres=16")
  posts.ts      getPosts / getSearchPosts
  meta.ts       getMeta   (links look like "movie/603" or "tv/1399")
  episodes.ts   getEpisodes (url looks like "tv/1399/season/1")
  skips.ts      TheIntroDB lookups (intro / recap / credits timestamps)
  stream.ts     resolves TMDB links through 4KHDHub / HubCloud
  settings.ts   settings UI
```

To add a row, add `{ title, filter }` to `catalog.ts`. Filters can use the tokens
`{today}`, `{weekAgo}` and `{monthAgo}`. Bump `version` in `manifest.json` after changes so the app updates.

## Testing

```bash
npm run test:provider -- tmdb getPosts --rebuild   # single function
npm run auto                                       # dev server for testing in the app
```

## Icon

`assets/tmdb.png` is the provider icon. The app loads the icon from a URL in `manifest.json`, so after pushing to GitHub set:

```json
"icon": "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/assets/tmdb.png"
```

The bundled icon is a simple placeholder. You can replace it with the official logo from
https://www.themoviedb.org/about/logos-attribution (keep it a PNG, the app can't draw SVGs in every screen).

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
