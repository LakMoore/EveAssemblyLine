"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type DiffView = "full" | "short";
type DiffRow = { kind: "equal" | "removed" | "added" | "omitted"; text?: string };

const SHORT_CONTEXT_LINES = 5;
const SHORT_LOOKAHEAD_LINES = 64;
const SHORT_CHANGED_LINES_PER_BLOCK = 40;
const SHORT_OUTPUT_LIMIT = 2000;

type LineReader = {
  lineCount: number;
  lineAt: (index: number) => string;
};

/** Formats retained JSON for readable administrator comparison. */
function prettyJson(value: string): string {
  try {
    return JSON.stringify(sortJsonKeys(JSON.parse(value)), null, 2);
  }
  catch {
    return value;
  }
}

/** Sorts object keys without changing array order so property relocation is not reported as a change. */
function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object
      .entries(value)
      .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
      .map(([key, nestedValue]) => [key, sortJsonKeys(nestedValue)]),
  );
}

/** Creates random-access line views without retaining a second copy of every line. */
function createLineReader(value: string): LineReader {
  const lineStarts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") lineStarts.push(index + 1);
  }

  return {
    lineCount: lineStarts.length,
    lineAt: (index) => {
      const start = lineStarts[index];
      const end = index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : value.length;
      return value.slice(start, end);
    },
  };
}

/** Finds a nearby shared line so short mode can align changes with bounded lookahead. */
function findSharedLine(
  original: LineReader,
  current: LineReader,
  originalStart: number,
  currentStart: number,
): { originalIndex: number; currentIndex: number } | null {
  const originalEnd = Math.min(original.lineCount, originalStart + SHORT_LOOKAHEAD_LINES);
  const currentEnd = Math.min(current.lineCount, currentStart + SHORT_LOOKAHEAD_LINES);
  const currentLines = new Map<string, number>();
  for (let currentIndex = currentStart; currentIndex < currentEnd; currentIndex += 1) {
    const currentLine = current.lineAt(currentIndex);
    if (!currentLines.has(currentLine)) currentLines.set(currentLine, currentIndex);
  }
  for (let originalIndex = originalStart; originalIndex < originalEnd; originalIndex += 1) {
    const currentIndex = currentLines.get(original.lineAt(originalIndex));
    if (currentIndex !== undefined) {
      return { originalIndex, currentIndex };
    }
  }
  return null;
}

/** Builds a bounded-memory diff focused on changed lines and nearby context. */
function createShortDiffRows(original: LineReader, current: LineReader): DiffRow[] {
  const rows: DiffRow[] = [];
  const pendingEqualLines: string[] = [];
  let pendingEqualCount = 0;
  let originalIndex = 0;
  let currentIndex = 0;
  let hasChanges = false;
  let changedLinesInBlock = 0;
  let changedBlockHasOmittedLines = false;

  const appendOmittedRow = () => {
    if (rows.at(-1)?.kind === "omitted") return;
    if (rows.length >= SHORT_OUTPUT_LIMIT) {
      rows[SHORT_OUTPUT_LIMIT - 1] = { kind: "omitted" };
      return;
    }
    rows.push({ kind: "omitted" });
  };
  const appendRow = (row: DiffRow) => {
    if (rows.length >= SHORT_OUTPUT_LIMIT) {
      appendOmittedRow();
      return;
    }
    rows.push(row);
  };
  const flushPendingEqualLines = () => {
    if (pendingEqualCount === 0) return;
    if (pendingEqualCount > SHORT_CONTEXT_LINES) appendOmittedRow();
    for (const text of pendingEqualLines) appendRow({ kind: "equal", text });
    pendingEqualLines.length = 0;
    pendingEqualCount = 0;
    changedLinesInBlock = 0;
    changedBlockHasOmittedLines = false;
  };
  const appendChangedRow = (row: DiffRow) => {
    if (changedLinesInBlock >= SHORT_CHANGED_LINES_PER_BLOCK) {
      if (!changedBlockHasOmittedLines) appendOmittedRow();
      changedBlockHasOmittedLines = true;
      return;
    }
    appendRow(row);
    changedLinesInBlock += 1;
  };
  const appendPendingEqualLine = (text: string) => {
    pendingEqualCount += 1;
    pendingEqualLines.push(text);
    if (pendingEqualLines.length > SHORT_CONTEXT_LINES) pendingEqualLines.shift();
  };

  while (originalIndex < original.lineCount || currentIndex < current.lineCount) {
    if (
      originalIndex < original.lineCount
      && currentIndex < current.lineCount
      && original.lineAt(originalIndex) === current.lineAt(currentIndex)
    ) {
      appendPendingEqualLine(original.lineAt(originalIndex));
      originalIndex += 1;
      currentIndex += 1;
      continue;
    }

    flushPendingEqualLines();
    hasChanges = true;
    const sharedLine = findSharedLine(original, current, originalIndex, currentIndex);
    if (sharedLine) {
      while (originalIndex < sharedLine.originalIndex) {
        appendChangedRow({ kind: "removed", text: original.lineAt(originalIndex) });
        originalIndex += 1;
      }
      while (currentIndex < sharedLine.currentIndex) {
        appendChangedRow({ kind: "added", text: current.lineAt(currentIndex) });
        currentIndex += 1;
      }
      continue;
    }

    if (originalIndex < original.lineCount) {
      appendChangedRow({ kind: "removed", text: original.lineAt(originalIndex) });
      originalIndex += 1;
    }
    if (currentIndex < current.lineCount) {
      appendChangedRow({ kind: "added", text: current.lineAt(currentIndex) });
      currentIndex += 1;
    }
  }

  if (hasChanges) flushPendingEqualLines();
  return rows;
}

/** Builds a line-level Myers diff for two formatted JSON documents. */
function createFullDiffRows(originalLines: string[], currentLines: string[]): DiffRow[] {
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);
  const maxDistance = originalLines.length + currentLines.length;
  let editDistance = maxDistance;

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const previousDown = frontier.get(diagonal + 1) ?? 0;
      const previousRight = frontier.get(diagonal - 1) ?? 0;
      let originalIndex =
        diagonal === -distance || (diagonal !== distance && previousRight < previousDown)
          ? previousDown
          : previousRight + 1;
      let currentIndex = originalIndex - diagonal;
      while (
        originalIndex < originalLines.length
        && currentIndex < currentLines.length
        && originalLines[originalIndex] === currentLines[currentIndex]
      ) {
        originalIndex += 1;
        currentIndex += 1;
      }
      frontier.set(diagonal, originalIndex);
      if (originalIndex >= originalLines.length && currentIndex >= currentLines.length) {
        editDistance = distance;
        break;
      }
    }
    trace.push(new Map(frontier));
    if (editDistance === distance) break;
  }

  const rows: DiffRow[] = [];
  let originalIndex = originalLines.length;
  let currentIndex = currentLines.length;
  for (let distance = editDistance; distance > 0; distance -= 1) {
    const previousFrontier = trace[distance - 1];
    const diagonal = originalIndex - currentIndex;
    const previousDown = previousFrontier.get(diagonal + 1) ?? 0;
    const previousRight = previousFrontier.get(diagonal - 1) ?? 0;
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && previousRight < previousDown)
        ? diagonal + 1
        : diagonal - 1;
    const previousOriginalIndex = previousFrontier.get(previousDiagonal) ?? 0;
    const previousCurrentIndex = previousOriginalIndex - previousDiagonal;

    while (originalIndex > previousOriginalIndex && currentIndex > previousCurrentIndex) {
      rows.push({ kind: "equal", text: originalLines[originalIndex - 1] });
      originalIndex -= 1;
      currentIndex -= 1;
    }
    if (originalIndex === previousOriginalIndex) {
      rows.push({ kind: "added", text: currentLines[currentIndex - 1] });
      currentIndex -= 1;
    }
    else {
      rows.push({ kind: "removed", text: originalLines[originalIndex - 1] });
      originalIndex -= 1;
    }
  }
  while (originalIndex > 0 && currentIndex > 0) {
    rows.push({ kind: "equal", text: originalLines[originalIndex - 1] });
    originalIndex -= 1;
    currentIndex -= 1;
  }
  while (originalIndex > 0) {
    rows.push({ kind: "removed", text: originalLines[originalIndex - 1] });
    originalIndex -= 1;
  }
  while (currentIndex > 0) {
    rows.push({ kind: "added", text: currentLines[currentIndex - 1] });
    currentIndex -= 1;
  }
  return rows.reverse();
}

/** Renders full or focused differences between two retained JSON responses. */
export default function AdminResponseDiff({
  original,
  current,
}: {
  original: string;
  current: string;
}) {
  const [view, setView] = useState<DiffView>("short");
  const originalJson = prettyJson(original);
  const currentJson = prettyJson(current);
  const rows =
    view === "short"
      ? createShortDiffRows(createLineReader(originalJson), createLineReader(currentJson))
      : createFullDiffRows(originalJson.split("\n"), currentJson.split("\n"));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2" role="group" aria-label="Diff view">
        <span className="text-xs text-muted-foreground">View</span>
        {(["full", "short"] as const).map((option) => (
          <Button
            key={option}
            type="button"
            variant={view === option ? "secondary" : "outline"}
            size="sm"
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "full" ? "Full" : "Short"}
          </Button>
        ))}
      </div>
      <pre className="max-h-128 overflow-auto border bg-muted/30 p-4 text-xs">
        {rows.length === 0 ? (
          <span className="block text-muted-foreground">No differences.</span>
        ) : (
          rows.map((row, index) => {
            if (row.kind === "omitted") {
              return (
                <span key={index} className="block text-muted-foreground">
                  ...
                </span>
              );
            }
            if (row.kind === "equal") {
              return (
                <span key={index} className="block">
                  {` ${row.text}`}
                </span>
              );
            }
            return (
              <span
                key={index}
                className={`block ${row.kind === "removed" ? "text-destructive" : "text-success"}`}
              >
                {row.kind === "removed" ? "- " : "+ "}
                {row.text}
              </span>
            );
          })
        )}
      </pre>
    </div>
  );
}
