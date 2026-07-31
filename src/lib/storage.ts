import storage from "node-persist";

let initialized = false;

export async function initStorage() {
  if (!initialized) {
    await storage.init({ dir: process.env.STORAGE_DIR ?? "./data", ttl: false });
    initialized = true;
  }
  return storage;
}