import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rawDir = resolve("sde/raw");
const archivePath = join(tmpdir(), "assemblyline-sde.zip");
const manifestUrl = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
const archiveUrl = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const requestHeaders = {
  Accept: "application/json, application/zip, application/octet-stream",
  "User-Agent": "AssemblyLine/0.1 (EVE Online SDE client)",
};

interface LatestSdeManifest {
  buildNumber: number;
  releaseDate?: string;
}

function readLocalBuildNumber() {
  const versionPath = join(rawDir, "version.json");
  if (!existsSync(versionPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(versionPath, "utf8")) as { buildNumber?: unknown };
    return typeof value.buildNumber === "number" ? value.buildNumber : undefined;
  } catch {
    return undefined;
  }
}

async function fetchManifest(): Promise<LatestSdeManifest> {
  const response = await fetch(manifestUrl, { headers: requestHeaders });
  if (!response.ok) throw new Error(`Official EVE SDE manifest failed: HTTP ${response.status} from ${manifestUrl}`);
  const value = (await response.json()) as Partial<LatestSdeManifest>;
  const buildNumber = value.buildNumber;
  if (typeof buildNumber !== "number" || !Number.isInteger(buildNumber)) throw new Error(`Official EVE SDE manifest did not contain a valid buildNumber: ${manifestUrl}`);
  return { buildNumber, releaseDate: value.releaseDate };
}

async function downloadAndExtract(destination: string, localArchive?: string) {
  if (localArchive) {
    if (!existsSync(resolve(localArchive))) throw new Error(`SDE_ARCHIVE does not exist: ${resolve(localArchive)}`);
    await execFileAsync("unzip", ["-q", "-o", resolve(localArchive), "-d", destination]);
    return;
  }
  const response = await fetch(process.env.SDE_URL ?? archiveUrl, { headers: requestHeaders });
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Official EVE SDE archive failed: HTTP ${response.status} from ${process.env.SDE_URL ?? archiveUrl}${detail ? ` (${detail})` : ""}`);
  }
  await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), createWriteStream(archivePath));
  await execFileAsync("unzip", ["-q", "-o", archivePath, "-d", destination]);
  await rm(archivePath, { force: true });
}

async function main() {
  const manifest = await fetchManifest();
  const currentBuild = readLocalBuildNumber();
  if (!process.env.SDE_ARCHIVE && currentBuild === manifest.buildNumber) {
    console.log(`SDE build ${manifest.buildNumber} is already present; nothing to download.`);
    return;
  }

  mkdirSync(resolve("sde"), { recursive: true });
  const stagingDir = await mkdtemp(join(resolve("sde"), ".assemblyline-sde-"));
  try {
    await downloadAndExtract(stagingDir, process.env.SDE_ARCHIVE);
    await rm(rawDir, { recursive: true, force: true });
    await rename(stagingDir, rawDir);
    writeFileSync(join(rawDir, "version.json"), JSON.stringify({ buildNumber: manifest.buildNumber, releaseDate: manifest.releaseDate, manifestUrl, archiveUrl }, null, 2));
    console.log(`SDE build ${manifest.buildNumber} extracted to ${rawDir}`);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });