import type { SdeLanguage } from "./languages";

export type StructureSize = "Small" | "Medium" | "Large" | "Extra Large";
export type StructureType = {
  name: string;
  size: StructureSize;
  typeId: number;
  sizeId: number;
};

const structureTypesCache = new Map<string, Promise<StructureType[]>>();

export function fetchStructureTypes(language: SdeLanguage) {
  const cached = structureTypesCache.get(language);
  if (cached) return cached;

  const request = fetch(`/api/reference/structure-types?language=${language}`).then(
    async (response) => {
      const data = (await response.json()) as { items?: StructureType[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "SDE structure data is unavailable.");
      if (!Array.isArray(data.items) || data.items.length === 0) {
        throw new Error("SDE structure data is unavailable.");
      }
      return data.items;
    },
  );
  structureTypesCache.set(language, request);
  void request.catch(() => structureTypesCache.delete(language));
  return request;
}
