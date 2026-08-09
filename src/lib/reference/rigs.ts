import type { SdeLanguage } from "./languages";

export type SdeRig = {
  name: string;
  size: "Medium" | "Large" | "Extra Large";
  reprocessingBonus: number;
};

const rigsCache = new Map<string, Promise<SdeRig[]>>();

export function fetchRigs(language: SdeLanguage) {
  const cached = rigsCache.get(language);
  if (cached) return cached;

  const request = fetch(`/api/reference/rigs?language=${language}`)
    .then((response) => response.json() as Promise<{ items?: SdeRig[]; error?: string }>)
    .then((data) => data.items ?? []);
  rigsCache.set(language, request);
  void request.catch(() => rigsCache.delete(language));
  return request;
}