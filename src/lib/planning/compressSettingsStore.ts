import { compressSettingsStoreName, getPlanningDatabase } from "./planningDatabase";

export type CompressSettings = {
  locationId: string;
  characterId: string;
  implantId: string;
  marketId: string;
  orderType: "buy-1-day" | "buy-5-day" | "sell";
  items: CompressMaterial[];
};

export type CompressMaterial = {
  name: string;
  typeId: number;
  quantity: number;
  category?: "blueprint" | "bpo" | "bpc" | "reaction" | "item";
  imageVariation?: "icon" | "bp" | "bpc";
};

const settingsKey = "selected";
const defaults: CompressSettings = {
  locationId: "npc",
  characterId: "all-zero",
  implantId: "none",
  marketId: "jita",
  orderType: "buy-1-day",
  items: [],
};

export async function loadCompressSettings(): Promise<CompressSettings> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(compressSettingsStoreName, "readonly")
        .objectStore(compressSettingsStoreName)
        .get(settingsKey);
      request.onsuccess = () =>
        resolve({ ...defaults, ...(request.result as Partial<CompressSettings> | undefined) });
      request.onerror = () =>
        reject(request.error ?? new Error("Could not load compression settings."));
    });
  }
  catch {
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
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save compression settings."));
    });
  }
  catch {}
}
