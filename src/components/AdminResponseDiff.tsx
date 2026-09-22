"use client";

import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";

type DiffView = "full" | "short";
type DiffRow = { kind: "equal" | "removed" | "added"; text: string };

/** Formats retained JSON for readable administrator comparison. */
function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  }
  catch {
    return value;
  }
}

/** Builds a line-level Myers diff for two formatted JSON documents. */
function createDiffRows(originalLines: string[], currentLines: string[]): DiffRow[] {
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
  const [view, setView] = useState<DiffView>("full");
  const rows = createDiffRows(prettyJson(original).split("\n"), prettyJson(current).split("\n"));
  const changedRows = new Set(rows.flatMap((row, index) => (row.kind === "equal" ? [] : [index])));
  const shortViewRows = new Set<number>();
  for (const changedRow of changedRows) {
    for (let index = Math.max(0, changedRow - 5); index <= changedRow + 5; index += 1) {
      shortViewRows.add(index);
    }
  }
  const visibleRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => view === "full" || shortViewRows.has(index));
  const lastVisibleIndex = visibleRows.at(-1)?.index ?? -1;
  const hasTrailingOmittedRows =
    view === "short" && lastVisibleIndex >= 0 && lastVisibleIndex < rows.length - 1;

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
        {visibleRows.length === 0 ? (
          <span className="block text-muted-foreground">No differences.</span>
        ) : (
          visibleRows.map(({ row, index }, visibleIndex) => {
            const previousIndex = visibleIndex === 0 ? -1 : visibleRows[visibleIndex - 1].index;
            const hasOmittedRows = index > previousIndex + 1;
            return (
              <Fragment key={index}>
                {hasOmittedRows ? <span className="block text-muted-foreground">...</span> : null}
                {row.kind === "equal" ? (
                  <span className="block"> {row.text}</span>
                ) : (
                  <span
                    className={`block ${
                      row.kind === "removed" ? "text-destructive" : "text-success"
                    }`}
                  >
                    {row.kind === "removed" ? "- " : "+ "}
                    {row.text}
                  </span>
                )}
              </Fragment>
            );
          })
        )}
        {hasTrailingOmittedRows ? <span className="block text-muted-foreground">...</span> : null}
      </pre>
    </div>
  );
}
