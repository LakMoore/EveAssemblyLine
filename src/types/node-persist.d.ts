declare module "node-persist" {
  interface Storage {
    init(options: { dir: string; ttl: false }): Promise<void>;
    getItem<T>(key: string): Promise<T | undefined>;
    setItem<T>(key: string, value: T): Promise<void>;
  }

  const storage: Storage;
  export default storage;
}