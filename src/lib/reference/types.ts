import type { SdeLanguage } from "./languages";

export type TypeMetadata = {
  typeId: number;
  name: string;
  assembledVolume?: number;
  packagedVolume?: number;
  category?: "bpo" | "bpc" | "reaction" | "item";
  marketCategory?: string;
};

const maxUrlLength = 2000;
const metadataCache = new Map<string, Promise<TypeMetadata[]>>();

export function fetchTypeMetadata(typeIds: number[], language: SdeLanguage) {
  const uniqueTypeIds = [...new Set(typeIds)];
  const cacheKey = `${language}:${uniqueTypeIds.join(",")}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;

  const request = fetchTypeMetadataRequests(uniqueTypeIds, language);
  metadataCache.set(cacheKey, request);
  void request.catch(() => metadataCache.delete(cacheKey));
  return request;
}

async function fetchTypeMetadataRequests(uniqueTypeIds: number[], language: SdeLanguage) {
  const requests: string[] = [];
  let currentTypeIds: number[] = [];

  for (const typeId of uniqueTypeIds) {
    const candidateTypeIds = [...currentTypeIds, typeId];
    const candidate = new URLSearchParams({
      language,
      typeId: candidateTypeIds.join(","),
    });
    if (`/api/reference/types?${candidate}`.length > maxUrlLength && currentTypeIds.length > 0) {
      const current = new URLSearchParams({
        language,
        typeId: currentTypeIds.join(","),
      });
      requests.push(`/api/reference/types?${current}`);
      currentTypeIds = [typeId];
    } else {
      currentTypeIds = candidateTypeIds;
    }
  }
  if (currentTypeIds.length > 0) {
    const current = new URLSearchParams({
      language,
      typeId: currentTypeIds.join(","),
    });
    requests.push(`/api/reference/types?${current}`);
  }

  const responses = await Promise.all(
    requests.map(async (url) => {
      const response = await fetch(url);
      const data = (await response.json()) as { items?: TypeMetadata[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not load item metadata.");
      return data.items ?? [];
    }),
  );
  return responses.flat();
}