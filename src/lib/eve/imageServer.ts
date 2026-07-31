const imageServerUrl = "https://images.evetech.net";

export function eveTypeImageUrl(typeId: number, variation: "icon" | "bpo" | "bpc" = "icon", size = 64) {
  return `${imageServerUrl}/types/${typeId}/${variation}?size=${size}`;
}