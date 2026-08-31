import type { SdeLanguage } from "./languages";

export type TypeMetadata = {
  typeId: number;
  name: string;
  techLevel?: number;
  assembledVolume?: number;
  packagedVolume?: number;
  category?: "blueprint" | "reactionformula" | "item";
  marketCategory?: string;
};

const metadataCache = new Map<string, Promise<TypeMetadata[]>>();
const resolvedMetadata = new Map<string, Map<number, TypeMetadata>>();

export function fetchTypeMetadata(typeIds: number[], language: SdeLanguage) {
  const uniqueTypeIds = [...new Set(typeIds)];
  const languageCache = resolvedMetadata.get(language) ?? new Map<number, TypeMetadata>();
  resolvedMetadata.set(language, languageCache);
  const missingTypeIds = uniqueTypeIds.filter((typeId) => !languageCache.has(typeId));
  if (missingTypeIds.length === 0) {
    return Promise.resolve(
      uniqueTypeIds.flatMap((typeId) => {
        const metadata = languageCache.get(typeId);
        return metadata ? [metadata] : [];
      }),
    );
  }
  const cacheKey = `${language}:${missingTypeIds.join(",")}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;

  const request = fetchTypeMetadataRequests(missingTypeIds, language).then((metadata) => {
    for (const item of metadata) languageCache.set(item.typeId, item);
    return uniqueTypeIds.flatMap((typeId) => {
      const item = languageCache.get(typeId);
      return item ? [item] : [];
    });
  });
  metadataCache.set(cacheKey, request);
  void request.catch(() => metadataCache.delete(cacheKey));
  return request;
}

async function fetchTypeMetadataRequests(uniqueTypeIds: number[], language: SdeLanguage) {
  const response = await fetch(
    "/api/reference/types",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, typeIds: uniqueTypeIds }),
    },
  );
  const data = (await response.json()) as { items?: TypeMetadata[]; error?: string };
  if (!response.ok) throw new Error(data.error ?? "Could not load item metadata.");
  return data.items ?? [];
}
