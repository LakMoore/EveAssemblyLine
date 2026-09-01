import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore, type Firestore } from "firebase-admin/firestore";

const storageCollection = "assemblyLineStorage";
let firestorePromise: Promise<Firestore> | undefined;

export interface Storage {
  getItem<T>(key: string): Promise<T | undefined>;
  getItemsByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T | undefined }>>;
  setItem<T>(key: string, value: T): Promise<void>;
  deleteItem(key: string): Promise<void>;
  runTransaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
}

export interface StorageTransaction {
  getItem<T>(key: string): Promise<T | undefined>;
  getItemsByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T | undefined }>>;
  setItem<T>(key: string, value: T): void;
  deleteItem(key: string): void;
}

function getFirestoreDatabase() {
  if (!firestorePromise) {
    firestorePromise = Promise.resolve().then(() => {
      const app = getApps()[0] ?? initializeApp(getFirebaseOptions());
      return getFirestore(app);
    });
  }
  return firestorePromise;
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object
      .entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)]),
  );
}

function getFirebaseOptions() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { credential: cert({ projectId, clientEmail, privateKey }) };
  }
  if (projectId) return { credential: applicationDefault(), projectId };
  return undefined;
}

export async function initStorage() {
  const database = await getFirestoreDatabase();
  return {
    async getItem<T>(key: string) {
      const snapshot = await database.collection(storageCollection).doc(key).get();
      return snapshot.exists ? (snapshot.data()?.value as T) : undefined;
    },
    async getItemsByPrefix<T>(prefix: string) {
      const snapshots = await database
        .collection(storageCollection)
        .where(FieldPath.documentId(), ">=", prefix)
        .where(FieldPath.documentId(), "<", `${prefix}\uf8ff`)
        .get();
      return snapshots.docs.map((snapshot) => ({
        key: snapshot.id,
        value: snapshot.data().value as T | undefined,
      }));
    },
    async setItem<T>(key: string, value: T) {
      await database
        .collection(storageCollection)
        .doc(key)
        .set({
          value: withoutUndefined(value),
          updatedAt: new Date(),
        });
    },
    async deleteItem(key: string) {
      await database.collection(storageCollection).doc(key).delete();
    },
    async runTransaction<T>(callback: (transaction: StorageTransaction) => Promise<T>) {
      return database.runTransaction(async (transaction) =>
        callback({
          async getItem<K>(key: string) {
            const snapshot = await transaction.get(database.collection(storageCollection).doc(key));
            return snapshot.exists ? (snapshot.data()?.value as K) : undefined;
          },
          async getItemsByPrefix<K>(prefix: string) {
            const snapshots = await transaction.get(
              database
                .collection(storageCollection)
                .where(FieldPath.documentId(), ">=", prefix)
                .where(FieldPath.documentId(), "<", `${prefix}\uf8ff`),
            );
            return snapshots.docs.map((snapshot) => ({
              key: snapshot.id,
              value: snapshot.data().value as K | undefined,
            }));
          },
          setItem<K>(key: string, value: K) {
            transaction.set(
              database.collection(storageCollection).doc(key),
              {
                value: withoutUndefined(value),
                updatedAt: new Date(),
              },
            );
          },
          deleteItem(key: string) {
            transaction.delete(database.collection(storageCollection).doc(key));
          },
        }),
      );
    },
  } satisfies Storage;
}
