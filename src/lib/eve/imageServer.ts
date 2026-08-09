const imageServerUrl = "https://images.evetech.net";

export function eveCharacterPortraitUrl(characterId: number, size = 256) {
  return `${imageServerUrl}/characters/${characterId}/portrait?size=${size}`;
}

export function eveCorporationLogoUrl(corporationId: number, size = 256) {
  return `${imageServerUrl}/corporations/${corporationId}/logo?size=${size}`;
}

export function eveTypeImageUrl(
  typeId: number,
  variation: "icon" | "render" | "bp" | "bpc" | "relic" = "icon",
  size = 64,
) {
  return `${imageServerUrl}/types/${typeId}/${variation}?size=${size}`;
}
