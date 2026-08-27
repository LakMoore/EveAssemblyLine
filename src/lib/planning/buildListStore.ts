import type { ClientBuildItem } from "./types";
import { buildStoreName, getPlanningDatabase } from "./planningDatabase";

const currentListKey = "current";

function isBuildItem(value: unknown): value is ClientBuildItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string"
    && typeof item.categoryName === "string"
    && Number.isInteger(item.typeId)
    && Number.isInteger(item.quantity)
    && Number(item.quantity) > 0
  );
}

export async function loadBuildList(): Promise<ClientBuildItem[]> {
  const database = await getPlanningDatabase();
  return new Promise<ClientBuildItem[]>((resolve, reject) => {
    const request = database
      .transaction(buildStoreName, "readonly")
      .objectStore(buildStoreName)
      .get(currentListKey);
    request.onsuccess = () => {
      resolve(
        Array.isArray(request.result)
          ? request.result
              .filter(isBuildItem)
              .map((item) => {
                const { reprocessingEfficiency: _legacyEfficiency, ...buildItem } =
                  item as ClientBuildItem & { reprocessingEfficiency?: number };
                return {
                  ...buildItem,
                  me: typeof item.me === "number" ? item.me : 0,
                  te: typeof item.te === "number" ? item.te : 0,
                  fromCompression: item.fromCompression === true,
                };
              })
          : [],
      );
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Could not load the build list."));
    };
  });
}

export async function saveBuildList(items: ClientBuildItem[]) {
  const database = await getPlanningDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(buildStoreName, "readwrite");
    transaction.objectStore(buildStoreName).put(items, currentListKey);
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("Could not save the build list."));
    };
  });
}
