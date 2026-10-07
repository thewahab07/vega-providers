import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  PROVIDER_NAME,
  inferTypeFromPath,
  tmdbGet,
  toPost,
} from "./api";

// TMDB rejects any page above 500.
const MAX_PAGE = 500;

function mapResults(results: any[] | undefined, fallbackType?: "movie" | "tv") {
  const posts: Post[] = [];
  const seen: Record<string, boolean> = {};

  (results || []).forEach((item) => {
    const post = toPost(item, fallbackType);
    if (post && !seen[post.link]) {
      seen[post.link] = true;
      posts.push(post);
    }
  });

  return posts;
}

export const getPosts = async function ({
  filter,
  page,
  providerValue,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const currentPage = page && page > 0 ? page : 1;
  if (currentPage > MAX_PAGE) return [];

  try {
    const data = await tmdbGet<any>(
      providerContext,
      filter,
      { page: currentPage },
      signal,
    );

    if (currentPage > (data?.total_pages || 1)) return [];

    return mapResults(data?.results, inferTypeFromPath(filter));
  } catch (error) {
    throwProviderError(PROVIDER_NAME, "getPosts", error);
  }
};

export const getSearchPosts = async function ({
  searchQuery,
  page,
  providerValue,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const query = (searchQuery || "").trim();
  const currentPage = page && page > 0 ? page : 1;
  if (!query || currentPage > MAX_PAGE) return [];

  try {
    // multi search covers movies, TV shows and anime (people are filtered out)
    const data = await tmdbGet<any>(
      providerContext,
      "/search/multi",
      { query, page: currentPage },
      signal,
    );

    if (currentPage > (data?.total_pages || 1)) return [];

    return mapResults(data?.results);
  } catch (error) {
    throwProviderError(PROVIDER_NAME, "getSearchPosts", error);
  }
};
