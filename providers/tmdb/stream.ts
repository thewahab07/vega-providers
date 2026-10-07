import { Stream, ProviderContext } from "../types";

/**
 * TMDB only provides metadata, so there is nothing to play.
 * This file exists because the Vega app (and the test runner) require it.
 */
export const getStream = async function ({
  link,
  type,
  signal,
  providerContext,
  isDownload,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  return [];
};
