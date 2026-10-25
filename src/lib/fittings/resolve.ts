import { z } from "zod";
import {
  getDogmaAttributes,
  getDogmaEffects,
  getGroups,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import { FittingSlot, parseFitting, type ParsedFitting } from "@/lib/reference/fittings";
import { esiFittingSchema, fittingInputSchema, type FittingInput } from "./model";
import type { SdeLanguage } from "@/lib/reference/languages";

const slotBases: Record<FittingSlot, number> = {
  low: 11,
  medium: 19,
  high: 27,
  rig: 92,
  subsystem: 125,
  service: 164,
  cargo: 5,
  drone: 87,
  fighter: 158,
};
const effectSlots: Partial<Record<string, FittingSlot>> = {
  loPower: FittingSlot.Low,
  medPower: FittingSlot.Medium,
  hiPower: FittingSlot.High,
  rigSlot: FittingSlot.Rig,
  subSystem: FittingSlot.Subsystem,
  serviceSlot: FittingSlot.Service,
};
const strategicCruiserGroupId = 963;

/** Builds EFT section order from hull-specific subsystem and service-slot support. */
function getEftSlotOrder(
  shipTypeId: number,
  types: Awaited<ReturnType<typeof getTypes>>,
  dogma: Awaited<ReturnType<typeof getTypeDogma>>,
  attributes: Awaited<ReturnType<typeof getDogmaAttributes>>,
): FittingSlot[] {
  const ship = types.get(shipTypeId);
  const isStrategicCruiser = ship?.groupID === strategicCruiserGroupId;
  const hasServiceSlots = dogma
    .get(shipTypeId)
    ?.dogmaAttributes.some((attribute) => {
      const name = attributes.get(attribute.attributeID)?.name;
      return name === "serviceSlots" && attribute.value > 0;
    });
  const slotOrder = [FittingSlot.Low, FittingSlot.Medium, FittingSlot.High, FittingSlot.Rig];
  if (isStrategicCruiser) slotOrder.push(FittingSlot.Subsystem);
  if (hasServiceSlots) slotOrder.push(FittingSlot.Service);
  slotOrder.push(FittingSlot.Drone, FittingSlot.Cargo);
  return slotOrder;
}

/** Re-parses EFT once the hull is known, leaving other fitting formats unchanged. */
function parseFittingForShip(
  text: string,
  parsed: ParsedFitting | null,
  shipTypeId: number,
  types: Awaited<ReturnType<typeof getTypes>>,
  dogma: Awaited<ReturnType<typeof getTypeDogma>>,
  attributes: Awaited<ReturnType<typeof getDogmaAttributes>>,
): ParsedFitting | null {
  if (!parsed || parsed.format !== "eft") return parsed;
  return parseFitting(
    text,
    {
      eftSlotOrder: getEftSlotOrder(shipTypeId, types, dogma, attributes),
    },
  );
}

/** Resolves pasted fitting formats using the authoritative SDE rather than EFT section guesses. */
export async function resolveFittingText(
  text: string,
  language: SdeLanguage,
): Promise<FittingInput> {
  if (/^\s*\{/.test(text)) {
    const value: unknown = JSON.parse(text);
    const app = fittingInputSchema.safeParse(value);
    if (app.success) return app.data;
    const fitting = esiFittingSchema.omit({ fitting_id: true }).safeParse(value);
    if (!fitting.success) {
      throw new Error("The JSON must contain one ESI fitting with name, ship_type_id and items.");
    }
    return {
      name: fitting.data.name,
      description: fitting.data.description,
      shipTypeId: fitting.data.ship_type_id,
      items: fitting.data.items,
    };
  }
  const [types, dogma, effects, groups, attributes] = await Promise.all([
    getTypes(),
    getTypeDogma(),
    getDogmaEffects(),
    getGroups(),
    getDogmaAttributes(),
  ]);
  const dna = /^\d+:(?:\d+;\d+:)*:$/.test(text.trim());
  let parsed = dna ? null : parseFitting(text);
  const names = new Set(
    parsed
      ? [parsed.shipTypeName, ...parsed.items.map((item) => item.name)].map((name) =>
          name.toLowerCase(),
        )
      : [],
  );
  const byName = new Map<string, number>();
  if (parsed) {
    for (const type of types.values()) {
      for (const name of Object.values(type.name)) {
        if (typeof name === "string" && names.has(name.toLowerCase())) {
          byName.set(name.toLowerCase(), type._key);
        }
      }
    }
  }
  const shipTypeId = parsed
    ? byName.get(parsed.shipTypeName.toLowerCase())
    : Number(text.trim().split(":")[0]);
  if (!shipTypeId || !types.has(shipTypeId)) {
    throw new Error("The fitting ship type was not found in the SDE.");
  }
  parsed = parseFittingForShip(text, parsed, shipTypeId, types, dogma, attributes);
  const inputs = parsed
    ? parsed.items.map((item) => {
        const typeId = byName.get(item.name.toLowerCase());
        if (!typeId) throw new Error(`Unknown fitting item: ${item.name}`);
        return { typeId, quantity: item.quantity, slot: item.slot, slotIndex: item.slotIndex };
      })
    : text
        .trim()
        .split(":")
        .slice(1)
        .filter(Boolean)
        .map((item) => {
          const [typeId, quantity] = item.split(";").map(Number);
          if (
            !z.number().int().positive().safeParse(typeId).success
            || !z.number().int().positive().max(2_147_483_647).safeParse(quantity).success
            || !types.has(typeId)
          ) {
            throw new Error("The DNA fitting contains an invalid type or quantity.");
          }
          return { typeId, quantity, slot: undefined, slotIndex: 0 };
        });
  const nextSlot = new Map<FittingSlot, number>();
  const items: FittingInput["items"] = [];
  for (const item of inputs) {
    const type = types.get(item.typeId);
    const inferred =
      (dogma.get(item.typeId)?.dogmaEffects ?? []).flatMap((effect) => {
        const name = effects.get(effect.effectID)?.name;
        return name && effectSlots[name] ? [effectSlots[name]] : [];
      })[0]
      ?? (groups.get(type?.groupID ?? 0)?.categoryID === 18
        ? FittingSlot.Drone
        : FittingSlot.Cargo);
    const itemCategoryId = groups.get(type?.groupID ?? 0)?.categoryID;
    const isBayRow =
      item.slot === FittingSlot.Cargo
      || item.slot === FittingSlot.Drone
      || item.slot === FittingSlot.Fighter;
    const baySlot =
      itemCategoryId === 18
        ? FittingSlot.Drone
        : itemCategoryId === 87
          ? FittingSlot.Fighter
          : FittingSlot.Cargo;
    const slot = parsed?.format === "xml" ? (item.slot ?? inferred) : isBayRow ? baySlot : inferred;
    const isBay =
      slot === FittingSlot.Cargo || slot === FittingSlot.Drone || slot === FittingSlot.Fighter;
    const count = dna && !isBay ? item.quantity : 1;
    if (count > 8) {
      throw new Error("A DNA fitting cannot have more than eight modules in one slot group.");
    }
    for (let offset = 0; offset < count; offset += 1) {
      const index = parsed && item.slot === slot ? item.slotIndex : (nextSlot.get(slot) ?? 0);
      if (!isBay && index > 7) {
        throw new Error("The fitting exceeds the available inventory slot flags.");
      }
      items.push({
        type_id: item.typeId,
        quantity: dna && !isBay ? 1 : item.quantity,
        flag: slotBases[slot] + (isBay ? 0 : index),
      });
      nextSlot.set(slot, index + 1);
    }
  }
  const ship = types.get(shipTypeId);
  return fittingInputSchema.parse({
    name: parsed?.name ?? `${ship?.name[language] ?? ship?.name.en ?? shipTypeId} fitting`,
    description: "",
    shipTypeId,
    items,
  });
}
