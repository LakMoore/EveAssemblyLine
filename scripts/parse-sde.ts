import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { jsonrepair } from "jsonrepair";

const rawDir = resolve(".next/cache/assemblyline-sde/raw");
const processedDir = resolve("sde/processed");

async function parseJsonl(filePath: string) {
  const records: unknown[] = [];
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let pending = "";
  let startLine = 0;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim() && !pending) continue;
    if (!pending) startLine = lineNumber;
    pending += line;
    if (!line.trimEnd().endsWith("}")) continue;
    try {
      records.push(JSON.parse(pending));
    } catch {
      try {
        records.push(JSON.parse(jsonrepair(pending)));
      } catch (error) {
        throw new Error(
          `Invalid JSONL in ${filePath} line ${startLine}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    pending = "";
  }
  if (pending.trim())
    throw new Error(`Invalid JSONL in ${filePath} line ${startLine}: record was not terminated`);
  return records;
}

async function main() {
  if (!existsSync(rawDir))
    throw new Error("SDE raw directory is missing. Run npm run fetch-sde first.");
  await mkdir(processedDir, { recursive: true });
  const files = (await readdir(rawDir)).filter((file) => extname(file) === ".jsonl");
  if (files.length === 0)
    throw new Error(
      "No .jsonl files found in .next/cache/assemblyline-sde/raw. Run npm run fetch-sde first.",
    );
  for (const file of files) {
    await writeFile(
      join(processedDir, `${basename(file, ".jsonl")}.json`),
      JSON.stringify(await parseJsonl(join(rawDir, file))),
    );
    console.log(`Parsed ${file}`);
  }
  const repackagedVolumesPath = join(rawDir, "repackagedvolumes.json");
  if (!existsSync(repackagedVolumesPath))
    throw new Error("HoboLeaks repackaged volumes are missing. Run npm run fetch-sde first.");
  const repackagedVolumes: unknown = JSON.parse(readFileSync(repackagedVolumesPath, "utf8"));
  if (
    !repackagedVolumes ||
    typeof repackagedVolumes !== "object" ||
    Array.isArray(repackagedVolumes)
  )
    throw new Error("HoboLeaks repackaged volumes must be a JSON object.");
  await writeFile(join(processedDir, "repackagedvolumes.json"), JSON.stringify(repackagedVolumes));
  console.log("Parsed HoboLeaks repackaged volumes.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
