#!/usr/bin/env node
// scripts/shadcn-drift-check.js

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CWD = process.cwd();
const COMPONENTS_JSON_PATH = join(CWD, "components.json");
const UI_DIR = join(CWD, "src", "components", "ui");

// Read components.json
let componentsJson;
try {
  const raw = readFileSync(COMPONENTS_JSON_PATH, "utf-8");
  componentsJson = JSON.parse(raw);
}
catch (err) {
  console.error("❌ components.json not found or invalid");
  process.exit(1);
}

// Extract installed component names from components.json
// shadcn stores them under "components" or you can infer from the "ui" alias path.
// The most reliable way is to list files in components/ui and strip extension.
const expectedComponents: Set<string> = new Set();

let localFiles: string[] = [];
try {
  localFiles = readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
}
catch {
  // UI dir might not exist yet
}

if (localFiles.length === 0 && expectedComponents.size === 0) {
  console.error("❌ No components found in src/components/ui");
  process.exit(1);
}

if (expectedComponents.size === 0 && localFiles.length > 0) {
  // Infer component names from filenames
  for (const f of localFiles) {
    const name = f.replace(/\.tsx?$/, "");
    expectedComponents.add(name);
  }
}

let hasDrift: Set<string> = new Set();
let unknownFiles: Set<string> = new Set();

// Run dry-run add --diff for each component
for (const comp of Array.from(expectedComponents).sort()) {
  try {
    console.log(`Checking component: ${comp}`);

    const output = execSync(
      `npx shadcn@latest add ${comp} --dry-run --diff`,
      { encoding: "utf-8", cwd: CWD },
    );

    const text = output || "";

    // If there is no "No changes." in the output, it means there is drift.
    if (!text.includes("│ No changes.")) {
      console.error(`❌ Drift detected in component: ${comp}`);
      console.error(text);
      hasDrift.add(comp);
    }
    else {
      console.log(`✅ No drift in component: ${comp}`);
    }
  }
  catch (err) {
    // Non-zero exit or error from CLI
    console.error(`❌ Error checking component: ${comp}`);
    console.error(String(err));
    hasDrift.add(comp);
  }
}

// Check for unknown files in components/ui
const knownBasenames = new Set(Array.from(expectedComponents).map((c) => `${c}.tsx`));

for (const f of localFiles) {
  if (!knownBasenames.has(f)) {
    console.warn(`⚠️  Unknown file in components/ui: ${f}`);
    unknownFiles.add(f);
  }
}

if (hasDrift.size > 0) {
  console.error("\n❌ shadcn drift detected in the following components:");
  for (const comp of Array.from(hasDrift).sort()) {
    console.error(`- ${comp}`);
  }
  process.exit(1);
}

if (unknownFiles.size > 0) {
  console.warn("\n⚠️  Unknown files found in components/ui (may be intentional)");
  for (const f of Array.from(unknownFiles).sort()) {
    console.warn(`- ${f}`);
  }
  process.exit(1);
}

console.log("\n✅ No shadcn drift detected");
process.exit(0);
