import type { FittingInput } from "./model";

const fittingSlots = [
  { label: "Low", base: 11 },
  { label: "Medium", base: 19 },
  { label: "High", base: 27 },
  { label: "Rig", base: 92 },
  { label: "Subsystem", base: 125 },
  { label: "Service", base: 164 },
];

/** Builds a single EFT header line without allowing fitting names to inject new lines. */
function headerValue(value: string): string {
  return value.replace(/[\r\n\[\]]/g, " ").trim();
}

/** Formats a named fitting stack using EFT's conventional quantity suffix. */
function itemLine(
  typeId: number,
  quantity: number,
  typeNames: ReadonlyMap<number, string>,
): string {
  const name = typeNames.get(typeId);
  if (!name) throw new Error(`Could not resolve the name for fitting type ${typeId}.`);
  return quantity > 1 ? `${name} x${quantity}` : name;
}

/** Serializes a saved numeric fitting to EFT text with explicit slot-section boundaries. */
export function serializeEftFitting(
  fitting: FittingInput,
  typeNames: ReadonlyMap<number, string>,
  ammunitionTypeIds: ReadonlySet<number>,
): string {
  const shipName = typeNames.get(fitting.shipTypeId);
  if (!shipName) throw new Error(`Could not resolve the name for ship type ${fitting.shipTypeId}.`);

  const sections: string[][] = [];
  for (const slot of fittingSlots) {
    const lines: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const slotItems = fitting.items.filter((item) => item.flag === slot.base + index);
      const modules = slotItems.filter((item) => !ammunitionTypeIds.has(item.type_id));
      const ammunition = slotItems.filter((item) => ammunitionTypeIds.has(item.type_id));
      if (modules.length === 0 && ammunition.length === 0) {
        lines.push(`[Empty ${slot.label} Slot]`);
        continue;
      }
      for (const fittedModule of modules) {
        lines.push(itemLine(fittedModule.type_id, fittedModule.quantity, typeNames));
      }
      for (const charge of ammunition) {
        lines.push(itemLine(charge.type_id, charge.quantity, typeNames));
      }
    }
    sections.push(lines);
  }

  const droneItems = fitting.items.filter((item) => item.flag === 87 || item.flag === 158);
  sections.push(
    droneItems.length > 0
      ? droneItems.map((item) => itemLine(item.type_id, item.quantity, typeNames))
      : ["[Empty Drone Bay]"],
  );
  const cargoItems = fitting.items.filter((item) => item.flag === 5 || !isKnownSlotFlag(item.flag));
  sections.push(
    cargoItems.length > 0
      ? cargoItems.map((item) => itemLine(item.type_id, item.quantity, typeNames))
      : ["[Empty Cargo]"],
  );

  return [
    `[${headerValue(shipName)}, ${headerValue(fitting.name)}]`,
    ...sections.map((lines) => lines.join("\n")),
  ].join("\n\n");
}

/** Identifies inventory flags represented by dedicated EFT slot sections. */
function isKnownSlotFlag(flag: number): boolean {
  return (
    fittingSlots.some((slot) => flag >= slot.base && flag < slot.base + 8)
    || flag === 87
    || flag === 158
  );
}
