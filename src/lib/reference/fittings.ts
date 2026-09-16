import type { SdeLanguage } from "./languages";

export type EsiFittingItem = {
  flag: number;
  quantity: number;
  type_id: number;
};

export type EsiFitting = {
  fitting_id: number;
  name: string;
  ship_type_id: number;
  items: EsiFittingItem[];
};

export enum FittingSlot {
  Low = "low",
  Medium = "medium",
  High = "high",
  Rig = "rig",
  Subsystem = "subsystem",
  Service = "service",
  Cargo = "cargo",
  Drone = "drone",
}

export type ParsedFittingItem = {
  name: string;
  quantity: number;
  slot: FittingSlot;
  slotIndex: number;
};

export type FittingFormat = string;

export type ParsedFitting = {
  format: FittingFormat;
  name: string;
  shipTypeName: string;
  items: ParsedFittingItem[];
};

export type ResolvedFitting = {
  fitting: EsiFitting;
  items: ParsedFittingItem[];
};

export type FittingParser = {
  format: FittingFormat;
  canParse: (text: string) => boolean;
  parse: (text: string) => ParsedFitting;
};

// ESI fitting responses use numeric inventory flags, while ESI asset responses
// expose equivalent symbolic values such as "HiSlot0" and "ServiceSlot0".
const esiFittingFlagBases: Record<FittingSlot, number> = {
  [FittingSlot.High]: 27,
  [FittingSlot.Medium]: 19,
  [FittingSlot.Low]: 11,
  [FittingSlot.Rig]: 92,
  [FittingSlot.Subsystem]: 125,
  [FittingSlot.Service]: 164,
  [FittingSlot.Cargo]: 5,
  [FittingSlot.Drone]: 87,
};

function parseEftItem(
  line: string,
  slot: FittingSlot,
  slotIndex: number,
): ParsedFittingItem | null {
  if (/^\[empty\b/i.test(line)) return null;
  const match = line.match(/^(.*?)\s+x(\d+)$/i);
  const name = (match?.[1] ?? line).trim();
  if (!name) return null;
  return {
    name,
    quantity: match ? Number(match[2]) : 1,
    slot,
    slotIndex,
  };
}

function parseEft(text: string): ParsedFitting {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift()?.match(/^\[([^,\]]+),\s*(.+)\]$/);
  if (!header) throw new Error("The fitting header must look like [Ship, Fitting name].");

  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.trim().length === 0) {
      sections.push([]);
    }
    else {
      sections[sections.length - 1].push(line.trim());
    }
  }
  while (sections.length > 0 && sections.at(-1)?.length === 0) sections.pop();
  const populatedSections = sections.filter((section) => section.length > 0);
  if (populatedSections.length < 5) {
    throw new Error("The fitting does not contain all EFT slot sections.");
  }

  const slotFlags =
    populatedSections.length >= 8
      ? [
          FittingSlot.Low,
          FittingSlot.Medium,
          FittingSlot.High,
          FittingSlot.Rig,
          FittingSlot.Subsystem,
          FittingSlot.Service,
          FittingSlot.Drone,
          FittingSlot.Cargo,
        ]
      : [
          FittingSlot.Low,
          FittingSlot.Medium,
          FittingSlot.High,
          FittingSlot.Rig,
          FittingSlot.Service,
          FittingSlot.Cargo,
          FittingSlot.Drone,
        ];
  const items: ParsedFittingItem[] = [];
  for (const [index, section] of populatedSections.entries()) {
    const slot = slotFlags[index] ?? FittingSlot.Cargo;
    section.forEach((line, itemIndex) => {
      const item = parseEftItem(line, slot, itemIndex);
      if (item) items.push(item);
    });
  }

  return {
    format: "eft",
    shipTypeName: header[1].trim(),
    name: header[2].trim(),
    items,
  };
}

function esiFittingFlag(item: ParsedFittingItem): number {
  const baseFlag = esiFittingFlagBases[item.slot];
  return item.slot === FittingSlot.Cargo || item.slot === FittingSlot.Drone
    ? baseFlag
    : baseFlag + item.slotIndex;
}

const fittingParsers: FittingParser[] = [
  {
    format: "eft",
    canParse: (text) => /^\s*\[[^,\]]+,\s*.+\]\s*$/m.test(text),
    parse: parseEft,
  },
];

/** Registers a fitting parser and returns a function that removes it again. */
export function registerFittingParser(parser: FittingParser) {
  if (fittingParsers.some((candidate) => candidate.format === parser.format)) {
    throw new Error(`A fitting parser for ${parser.format} is already registered.`);
  }
  fittingParsers.push(parser);
  return () => {
    const index = fittingParsers.indexOf(parser);
    if (index >= 0) fittingParsers.splice(index, 1);
  };
}

/** Parses a fitting with the first registered format that recognizes its text. */
export function parseFitting(text: string): ParsedFitting {
  const parser = fittingParsers.find((candidate) => candidate.canParse(text));
  if (!parser) throw new Error("This fitting format is not supported yet.");
  return parser.parse(text);
}

/** Resolves parsed fitting names to the ESI character fitting response shape. */
export async function resolveFitting(
  parsed: ParsedFitting,
  language: SdeLanguage,
): Promise<ResolvedFitting> {
  const names = [parsed.shipTypeName, ...parsed.items.map((item) => item.name)];
  const response = await fetch(
    "/api/reference/types",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, items: names.map((name) => ({ name })) }),
    },
  );
  const data = (await response.json()) as {
    items?: Array<{ typeId?: number; name?: string; error?: string }>;
    error?: string;
  };
  if (!response.ok) throw new Error(data.error ?? "Could not resolve the fitting items.");
  const resolvedItems = data.items ?? [];
  const ship = resolvedItems.at(0);
  if (!ship?.typeId) throw new Error(ship?.error ?? "The fitting ship type was not found.");
  const items = parsed.items.map((item, index) => {
    const resolved = resolvedItems.at(index + 1);
    if (!resolved?.typeId) {
      throw new Error(`${item.name}: ${resolved?.error ?? "item type was not found."}`);
    }
    return { item, typeId: resolved.typeId };
  });

  return {
    fitting: {
      fitting_id: 0,
      name: parsed.name,
      ship_type_id: ship.typeId,
      items: items.map(({ item, typeId }) => ({
        flag: esiFittingFlag(item),
        quantity: item.quantity,
        type_id: typeId,
      })),
    },
    items: items.map(({ item }) => item),
  };
}
