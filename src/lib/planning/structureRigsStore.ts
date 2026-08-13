import {
  emptyStructureRigs,
  mergeStructureRigs,
  normalizeStructureRigs,
  structureRigsKey,
  structureRigsName,
  type StructureRigsPayload,
} from "./structureRigs";
import type { KnownStructure } from "./preferences";

const localStorageKey = "assembly-line-structure-rigs";

export function loadCachedStructureRigs(): StructureRigsPayload {
  if (typeof window === "undefined") return emptyStructureRigs;
  try {
    const stored = window.localStorage.getItem(localStorageKey);
    return stored ? normalizeStructureRigs(JSON.parse(stored)) : emptyStructureRigs;
  }
  catch {
    return emptyStructureRigs;
  }
}

function cacheStructureRigs(payload: StructureRigsPayload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localStorageKey, JSON.stringify(payload));
  }
  catch {}
}

/** Reads the collection rig map and reconciles it with the local cache. */
export async function fetchStructureRigs(): Promise<StructureRigsPayload> {
  const cached = loadCachedStructureRigs();
  try {
    const response = await fetch("/api/structures", { credentials: "same-origin" });
    if (!response.ok) return cached;
    const merged = mergeStructureRigs(cached, normalizeStructureRigs(await response.json()));
    cacheStructureRigs(merged);
    return merged;
  }
  catch {
    return cached;
  }
}

export function structureRigsFromStructures(structures: KnownStructure[]): StructureRigsPayload {
  const payload: StructureRigsPayload = {
    lastModified: new Date().toISOString(),
    structures: {},
  };
  for (const structure of structures) {
    const rigTypeIds = structure.rigTypeIds ?? [];
    if (!structure.systemId || rigTypeIds.length === 0) continue;
    const name = structureRigsName(structure.systemName, structure.name);
    payload.structures[structureRigsKey(structure.systemId, name)] = {
      systemId: structure.systemId,
      name,
      rigTypeIds,
    };
  }
  return payload;
}

export async function publishStructureRigs(
  payload: StructureRigsPayload,
): Promise<StructureRigsPayload> {
  cacheStructureRigs(payload);
  try {
    const response = await fetch(
      "/api/structures",
      {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return payload;
    const merged = normalizeStructureRigs(await response.json());
    cacheStructureRigs(merged);
    return merged;
  }
  catch {
    return payload;
  }
}
