import { ProviderContext, SettingsField } from "../types";

export const getSettingsSchema = async function ({
  providerContext,
}: {
  providerContext: ProviderContext;
}): Promise<SettingsField[]> {
  return [
    {
      key: "language",
      type: "select",
      label: "Metadata Language",
      description: "Language for titles, descriptions and episode names",
      options: [
        { label: "English", value: "en-US" },
        { label: "हिन्दी (Hindi)", value: "hi-IN" },
        { label: "العربية (Arabic)", value: "ar-SA" },
        { label: "Español", value: "es-ES" },
        { label: "Français", value: "fr-FR" },
        { label: "Deutsch", value: "de-DE" },
        { label: "Italiano", value: "it-IT" },
        { label: "Português (Brasil)", value: "pt-BR" },
        { label: "Русский", value: "ru-RU" },
        { label: "Türkçe", value: "tr-TR" },
        { label: "日本語", value: "ja-JP" },
        { label: "한국어", value: "ko-KR" },
        { label: "中文 (简体)", value: "zh-CN" },
      ],
      defaultValue: "en-US",
    },
    {
      key: "region",
      type: "text",
      label: "Region",
      description:
        "Two-letter country code used for release dates and 'Now Playing' / 'Upcoming' lists (e.g. US, GB, IN, PK). Leave empty for worldwide.",
      placeholder: "US",
      defaultValue: "",
    },
    {
      key: "includeAdult",
      type: "toggle",
      label: "Include adult content",
      description: "Show adult titles in search and genre/discover lists",
      defaultValue: false,
    },
    {
      key: "skipTimings",
      type: "toggle",
      label: "Skip intro / outro timings",
      description:
        "Fetch intro, recap and credits timestamps from TheIntroDB so the player can show a skip button. Turn off if episode lists load slowly.",
      defaultValue: true,
    },
    {
      key: "apiKey",
      type: "text",
      label: "TMDB API Key (optional)",
      description:
        "Use your own TMDB v3 API key instead of the built-in one. Leave empty to use the default.",
      placeholder: "Your TMDB v3 API key",
      defaultValue: "",
    },
  ];
};
