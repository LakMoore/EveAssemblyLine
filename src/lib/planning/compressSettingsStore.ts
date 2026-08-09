import { compressSettingsStoreName, getPlanningDatabase } from "./planningDatabase";

export type CompressSettings = {
  locationId: string;
  characterId: string;
  implantId: string;
};

const settingsKey = "selected";
const defaults: CompressSettings = { locationId: "npc", characterId: "all-zero", implantId: "none" };

export async function loadCompressSettings(): Promise<CompressSettings> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(compressSettingsStoreName, "readonly").objectStore(compressSettingsStoreName).get(settingsKey);
      request.onsuccess = () => resolve({ ...defaults, ...(request.result as Partial<CompressSettings> | undefined) });
      request.onerror = () => reject(request.error ?? new Error("Could not load compression settings."));
    });
  } catch {
    return defaults;
  }
}

export async function saveCompressSettings(settings: CompressSettings) {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(compressSettingsStoreName, "readwrite");
      transaction.objectStore(compressSettingsStoreName).put(settings, settingsKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save compression settings."));
    });
  } catch {}
}