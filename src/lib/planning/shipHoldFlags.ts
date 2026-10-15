const shipHoldLocationFlags = new Set([
  "Cargo",
  "ExpeditionHold",
  "FleetHangar",
  "InfrastructureHangar",
  "MoonMaterialBay",
  "SpecializedAmmoHold",
  "SpecializedAsteroidHold",
  "SpecializedFuelBay",
  "SpecializedGasHold",
  "SpecializedIceHold",
  "SpecializedIndustrialShipHold",
  "SpecializedLargeShipHold",
  "SpecializedMaterialBay",
  "SpecializedMediumShipHold",
  "SpecializedMineralHold",
  "SpecializedOreHold",
  "SpecializedPlanetaryCommoditiesHold",
  "SpecializedSalvageHold",
  "SpecializedShipHold",
  "SpecializedSmallShipHold",
]);

/** Returns whether a ship inventory location is allowed to contribute planning stock. */
export function isShipHoldLocationFlag(locationFlag: string): boolean {
  return shipHoldLocationFlags.has(locationFlag);
}
