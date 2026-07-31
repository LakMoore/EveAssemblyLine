import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const rawDir = resolve("sde/raw");
const processedDir = resolve("sde/processed");

async function parseJsonl(filePath: string) {
  const records: unknown[] = [];
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid JSONL in ${filePath}: ${error instanceof Error ? error.message : error}`); }
  }
  return records;
}

async function main() {
  if (!existsSync(rawDir)) throw new Error("SDE raw directory is missing. Run npm run fetch-sde first.");
  await mkdir(processedDir, { recursive: true });
  const files = (await readdir(rawDir)).filter((file) => extname(file) === ".jsonl");
  if (files.length === 0) throw new Error("No .jsonl files found in sde/raw. Run npm run fetch-sde first.");
  for (const file of files) {
    await writeFile(join(processedDir, `${basename(file, ".jsonl")}.json`), JSON.stringify(await parseJsonl(join(rawDir, file))));
    console.log(`Parsed ${file}`);
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });