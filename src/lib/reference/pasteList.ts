export type ParsedPasteItem = {
  name: string;
  quantity?: number;
};

function isIntegerValue(value: string): boolean {
  return /^\d[\d,]*$/.test(value);
}

function parseTsvLines(lines: string[]): ParsedPasteItem[] {
  return lines
    .filter((line) => !line.trimStart().startsWith("Total:"))
    .flatMap((line) => {
      const [name = "", quantityText = ""] = line.split("\t").map((value) => value.trim());
      if (name.length === 0) return [];
      if (!isIntegerValue(quantityText)) return [{ name }];
      return [{ name, quantity: Number(quantityText.replaceAll(",", "")) }];
    });
}

/** Parses pasted build items in either the normal list format or game-export TSV. */
export function parsePasteList(text: string): ParsedPasteItem[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.some((line) => line.includes("\t"))) return parseTsvLines(lines);

  return lines.map((line) => {
    const trimmedLine = line.trim();
    const match = trimmedLine.match(/^(.*?)\s+(\d+)$/);
    return match ? { name: match[1].trim(), quantity: Number(match[2]) } : { name: trimmedLine };
  });
}
