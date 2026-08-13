import type { SdeLanguage } from "./languages";

export type SdeRig = {
  typeId: number;
  name: string;
  size: "Medium" | "Large" | "Extra Large";
  reprocessingBonus: number;
};

const rigsCache = new Map<string, Promise<SdeRig[]>>();

export function fetchRigs(language: SdeLanguage) {
  const cached = rigsCache.get(language);
  if (cached) return cached;

  const request = fetch(`/api/reference/rigs?language=${language}`).then(async (response) => {
    const data = (await response.json()) as { items?: SdeRig[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "SDE rig data is unavailable.");
    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new Error("SDE rig data is unavailable.");
    }
    return data.items;
  });
  rigsCache.set(language, request);
  void request.catch(() => rigsCache.delete(language));
  return request;
}
