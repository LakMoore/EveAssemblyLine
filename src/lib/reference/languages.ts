export const sdeLanguages = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ru", label: "Русский" },
  { code: "zh", label: "中文" },
] as const;

export type SdeLanguage = (typeof sdeLanguages)[number]["code"];

export function isSdeLanguage(value: string | null): value is SdeLanguage {
  return sdeLanguages.some((language) => language.code === value);
}