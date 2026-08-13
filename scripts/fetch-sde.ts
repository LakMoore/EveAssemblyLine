import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { jsonrepair } from "jsonrepair";

const execFileAsync = promisify(execFile);
const rawDir = resolve(".next/cache/assemblyline-sde/raw");
const sdeCacheDir = resolve(".next/cache/assemblyline-sde");
const archivePath = join(tmpdir(), "assemblyline-sde.zip");
const manifestUrl = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
const archiveUrl =
  "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const hoboLeaksBaseUrl = "https://sde.hoboleaks.space/tq";
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
  if (!response.ok)
    throw new Error(
      `Official EVE SDE manifest failed: HTTP ${response.status} from ${manifestUrl}`,
    );
  const value = (await response.json()) as Partial<LatestSdeManifest>;
  const buildNumber = value.buildNumber;
  if (typeof buildNumber !== "number" || !Number.isInteger(buildNumber))
    throw new Error(
      `Official EVE SDE manifest did not contain a valid buildNumber: ${manifestUrl}`,
    );
  return { buildNumber, releaseDate: value.releaseDate };
}

async function downloadAndExtract(destination: string, localArchive?: string) {
  if (localArchive) {
    if (!existsSync(resolve(localArchive)))
      throw new Error(`SDE_ARCHIVE does not exist: ${resolve(localArchive)}`);
    await execFileAsync("unzip", ["-q", "-o", resolve(localArchive), "-d", destination]);
    return;
  }
  const response = await fetch(process.env.SDE_URL ?? archiveUrl, { headers: requestHeaders });
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `Official EVE SDE archive failed: HTTP ${response.status} from ${process.env.SDE_URL ?? archiveUrl}${detail ? ` (${detail})` : ""}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    createWriteStream(archivePath),
  );
  await execFileAsync("unzip", ["-q", "-o", archivePath, "-d", destination]);
  await rm(archivePath, { force: true });
}

async function validateJsonlFiles(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(join(directory, file)),
      crlfDelay: Infinity,
    });
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
        JSON.parse(pending);
      } catch {
        try {
          JSON.parse(jsonrepair(pending));
        } catch (error) {
          throw new Error(
            `Downloaded SDE file is invalid: ${file} line ${startLine}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      pending = "";
    }
    if (pending.trim())
      throw new Error(
        `Downloaded SDE file is invalid: ${file} line ${startLine}: record was not terminated`,
      );
  }
}

async function fetchRepackagedVolumes() {
  const metadataResponse = await fetch(`${hoboLeaksBaseUrl}/meta.json`, {
    headers: requestHeaders,
  });
  if (!metadataResponse.ok)
    throw new Error(`HoboLeaks metadata failed: HTTP ${metadataResponse.status}`);
  const metadata = (await metadataResponse.json()) as {
    files?: Record<
      string,
      { deprecated?: boolean; stale?: boolean; md5?: string; revision?: number }
    >;
  };
  const fileMetadata = metadata.files?.["repackagedvolumes.json"];
  if (!fileMetadata)
    throw new Error("HoboLeaks metadata does not describe repackagedvolumes.json.");
  if (fileMetadata.deprecated || fileMetadata.stale)
    throw new Error("HoboLeaks repackagedvolumes.json is marked deprecated or stale.");

  const response = await fetch(`${hoboLeaksBaseUrl}/repackagedvolumes.json`, {
    headers: requestHeaders,
  });
  if (!response.ok) throw new Error(`HoboLeaks repackaged volumes failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HoboLeaks repackagedvolumes.json must be an object.");
  for (const [typeId, volume] of Object.entries(value)) {
    if (
      !/^\d+$/.test(typeId) ||
      typeof volume !== "number" ||
      !Number.isFinite(volume) ||
      volume < 0
    )
      throw new Error(`HoboLeaks repackagedvolumes.json contains an invalid entry for ${typeId}.`);
  }

  writeFileSync(join(rawDir, "repackagedvolumes.json"), JSON.stringify(value));
  writeFileSync(
    join(rawDir, "hoboleaks-meta.json"),
    JSON.stringify(
      { source: `${hoboLeaksBaseUrl}/repackagedvolumes.json`, ...fileMetadata },
      null,
      2,
    ),
  );
  console.log(
    `Captured HoboLeaks repackaged volumes revision ${fileMetadata.revision ?? "unknown"}.`,
  );
}

async function main() {
  const manifest = await fetchManifest();
  const currentBuild = readLocalBuildNumber();
  mkdirSync(sdeCacheDir, { recursive: true });
  if (!process.env.SDE_ARCHIVE && currentBuild === manifest.buildNumber) {
    await fetchRepackagedVolumes();
    console.log(`SDE build ${manifest.buildNumber} is already present; nothing to download.`);
    return;
  }

  const attempts = process.env.SDE_ARCHIVE ? 1 : 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const stagingDir = await mkdtemp(join(sdeCacheDir, ".assemblyline-sde-"));
    try {
      await downloadAndExtract(stagingDir, process.env.SDE_ARCHIVE);
      await validateJsonlFiles(stagingDir);
      await rm(rawDir, { recursive: true, force: true });
      await rename(stagingDir, rawDir);
      writeFileSync(
        join(rawDir, "version.json"),
        JSON.stringify(
          {
            buildNumber: manifest.buildNumber,
            releaseDate: manifest.releaseDate,
            manifestUrl,
            archiveUrl,
          },
          null,
          2,
        ),
      );
      await fetchRepackagedVolumes();
      console.log(`SDE build ${manifest.buildNumber} extracted to ${rawDir}`);
      return;
    } catch (error) {
      lastError = error;
      await rm(stagingDir, { recursive: true, force: true });
      if (attempt < attempts) console.warn(`SDE download attempt ${attempt} failed; retrying.`);
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
