import { compressSettingsStoreName, getPlanningDatabase } from "./planningDatabase";
import type { RegionalAppraisalPriceType } from "@/lib/esi/marketHistory";

export type CompressSettings = {
  locationId: string;
  characterId: string;
  implantId: string;
  marketId: string;
  orderType: "buy-1-day" | "buy-5-day" | "sell";
  orePricesBuyMarketId: string;
  orePricesBuyPriceType: RegionalAppraisalPriceType;
  orePricesSellMarketId: string;
  orePricesSellPriceType: RegionalAppraisalPriceType;
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
  orderType: "sell",
  orePricesBuyMarketId: "jita",
  orePricesBuyPriceType: "sell",
  orePricesSellMarketId: "jita",
  orePricesSellPriceType: "buy",
  items: [],
};

export async function loadCompressSettings({
  fallbackOnError = true,
}: { fallbackOnError?: boolean } = {}): Promise<CompressSettings> {
  try {
    const database = await getPlanningDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(compressSettingsStoreName, "readonly")
        .objectStore(compressSettingsStoreName)
        .get(settingsKey);
      request.onsuccess = () => {
        const storedSettings = request.result as Partial<CompressSettings> | undefined;
        const legacyMarketId = storedSettings?.marketId ?? defaults.marketId;
        resolve({
          ...defaults,
          ...storedSettings,
          orePricesBuyMarketId: storedSettings?.orePricesBuyMarketId ?? legacyMarketId,
          orePricesSellMarketId: storedSettings?.orePricesSellMarketId ?? legacyMarketId,
        });
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not load compression settings."));
      };
    });
  }
  catch (error) {
    if (!fallbackOnError) throw error;
    return defaults;
  }
}

export async function saveCompressSettings(settings: CompressSettings) {
  try {
    const database = await getPlanningDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(compressSettingsStoreName, "readwrite");
      transaction.objectStore(compressSettingsStoreName).put(settings, settingsKey);
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Could not save compression settings."));
      };
    });
  }
  catch {}
}
