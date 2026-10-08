const urlsEndpoint =
  "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json";
const fallbackUrls: Record<string, string> = {
  "4khdhub": "https://4khdhub.one",
};

let cachedUrl: string | undefined;
let cachedAt = 0;

export async function getBaseUrl(providerValue: string): Promise<string> {
  if (cachedUrl && Date.now() - cachedAt < 60 * 60 * 1000) return cachedUrl;

  let url = "";
  try {
    const response = await fetch(urlsEndpoint);
    if (!response.ok) {
      throw new Error(`Provider URL configuration request failed: ${response.status}`);
    }
    const data = (await response.json()) as Record<string, { url?: string }>;
    url = data[providerValue]?.url || "";
  } catch {
    // Keep stream resolution working when the optional shared configuration is
    // unavailable (including the local test harness).
    url = fallbackUrls[providerValue] || "";
  }

  if (!url) throw new Error(`No base URL configured for ${providerValue}`);
  cachedUrl = url.replace(/\/+$/, "");
  cachedAt = Date.now();
  return cachedUrl;
}
