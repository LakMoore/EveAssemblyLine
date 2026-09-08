import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp, initStorage } from "@/lib/storage";

const statisticsStorageKey = "statistics";
const storageCollection = "assemblyLineStorage";

/** The durable application counters shown on the administrator dashboard. */
export type ApplicationStatistics = {
  plansCreated: number;
};

/** Increments the number of successfully calculated plans atomically. */
export async function incrementPlansCreated(): Promise<void> {
  await getFirestore(getFirebaseApp())
    .collection(storageCollection)
    .doc(statisticsStorageKey)
    .set(
      {
        value: {
          plansCreated: FieldValue.increment(1),
        },
        updatedAt: new Date(),
      },
      { merge: true },
    );
}

/** Reads the durable application counters for the administrator dashboard. */
export async function getApplicationStatistics(): Promise<ApplicationStatistics> {
  const storage = await initStorage();
  const statistics = await storage.getItem<ApplicationStatistics>(statisticsStorageKey);
  return {
    plansCreated: typeof statistics?.plansCreated === "number" ? statistics.plansCreated : 0,
  };
}
