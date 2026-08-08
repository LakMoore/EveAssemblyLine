const imageServerUrl = "https://images.evetech.net";

export function eveTypeImageUrl(
  typeId: number,
  variation: "icon" | "render" | "bp" | "bpc" | "relic" = "icon",
  size = 64,
) {
  return `${imageServerUrl}/types/${typeId}/${variation}?size=${size}`;
}