import type { SdeLanguage } from "./languages";
import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import { z } from "zod";

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
  Fighter = "fighter",
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
  parse: (text: string, options?: FittingParseOptions) => ParsedFitting;
};

export type FittingParseOptions = {
  eftSlotOrder?: readonly FittingSlot[];
};

// Parsed fittings use numeric inventory flags; the fitting boundary also normalizes
// modern ESI symbolic flags such as "HiSlot0" and "ServiceSlot0" to these values.
const esiFittingFlagBases: Record<FittingSlot, number> = {
  [FittingSlot.High]: 27,
  [FittingSlot.Medium]: 19,
  [FittingSlot.Low]: 11,
  [FittingSlot.Rig]: 92,
  [FittingSlot.Subsystem]: 125,
  [FittingSlot.Service]: 164,
  [FittingSlot.Cargo]: 5,
  [FittingSlot.Drone]: 87,
  [FittingSlot.Fighter]: 158,
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

function parseEft(text: string, options?: FittingParseOptions): ParsedFitting {
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

  const slotFlags =
    options?.eftSlotOrder
    ?? (populatedSections.length >= 8
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
        ]);
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
  return item.slot === FittingSlot.Cargo
    || item.slot === FittingSlot.Drone
    || item.slot === FittingSlot.Fighter
    ? baseFlag
    : baseFlag + item.slotIndex;
}

/** Parses a single native EVE XML fitting using a structured, entity-safe XML parser. */
function parseXml(text: string): ParsedFitting {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error("The fitting XML is invalid or contains unsupported entities.");
  }
  SyntaxValidator.validate(text);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
    isArray: (name) => name === "fitting" || name === "hardware",
  });
  const schema = z.object({
    fittings: z.object({
      fitting: z
        .array(
          z.object({
            name: z.string().min(1),
            shipType: z.object({ value: z.string().min(1) }),
            hardware: z
              .array(
                z.object({
                  type: z.string().min(1),
                  slot: z.string(),
                  qty: z.coerce.number().int().positive().default(1),
                }),
              )
              .default([]),
          }),
        )
        .length(1),
    }),
  });
  const document: unknown = parser.parse(text);
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new Error("Paste one complete EVE XML fitting at a time.");
  const fitting = parsed.data.fittings.fitting[0];
  const items = fitting.hardware.map((hardware): ParsedFittingItem => {
    const slot = hardware.slot.match(/^(low|med|hi|rig|subsystem|service) slot (\d+)$/i);
    const slots: Record<string, FittingSlot> = {
      low: FittingSlot.Low,
      med: FittingSlot.Medium,
      hi: FittingSlot.High,
      rig: FittingSlot.Rig,
      subsystem: FittingSlot.Subsystem,
      service: FittingSlot.Service,
    };
    const bayName = hardware.slot.toLowerCase();
    const area = slot
      ? slots[slot[1].toLowerCase()]
      : bayName === "drone bay"
        ? FittingSlot.Drone
        : bayName === "fighter bay"
          ? FittingSlot.Fighter
          : bayName === "cargo bay"
            ? FittingSlot.Cargo
            : undefined;
    if (!area) throw new Error(`Unsupported fitting slot: ${hardware.slot}`);
    return {
      name: hardware.type,
      quantity: hardware.qty,
      slot: area,
      slotIndex: slot ? Number(slot[2]) : 0,
    };
  });
  return { format: "xml", name: fitting.name, shipTypeName: fitting.shipType.value, items };
}

const fittingParsers: FittingParser[] = [
  { format: "xml", canParse: (text) => /^\s*</.test(text), parse: parseXml },
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
export function parseFitting(text: string, options?: FittingParseOptions): ParsedFitting {
  const parser = fittingParsers.find((candidate) => candidate.canParse(text));
  if (!parser) throw new Error("This fitting format is not supported yet.");
  return parser.parse(text, options);
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
