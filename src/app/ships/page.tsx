"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { loadClientShips, type ClientShipsResponse } from "@/lib/client/requestCache";
import styles from "../page.module.css";
import { ArrowRight, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";

type ShipAsset = NonNullable<ClientShipsResponse["assets"]>[number];
type ShipSummary = NonNullable<ClientShipsResponse["ships"]>[number];
type TypeName = Map<number, string>;
const shipItemIdParam = "shipItemId";

const priorityFlagPattern = /^(HiSlot|MedSlot|LoSlot|RigSlot)(\d+)$/;
const slotGroupDetails = new Map([
  ["HiSlot", { label: "High Slots", order: 0 }],
  ["MedSlot", { label: "Medium Slots", order: 1 }],
  ["LoSlot", { label: "Low Slots", order: 2 }],
  ["RigSlot", { label: "Rig Slots", order: 3 }],
]);

function formatAssetGroupLabel(flag: string) {
  return flag.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function getAssetGroup(flag: string) {
  const match = flag.match(priorityFlagPattern);
  if (match) {
    const details = slotGroupDetails.get(match[1]);
    return {
      key: match[1],
      label: details?.label ?? match[1],
      order: details?.order ?? 99,
      slot: Number(match[2]),
    };
  }
  return { key: flag, label: formatAssetGroupLabel(flag), order: 4, slot: Number.MAX_SAFE_INTEGER };
}

export default function ShipsPage() {
  const [data, setData] = useState<ClientShipsResponse | null>(null);
  const [selectedShipItemId, setSelectedShipItemId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get(shipItemIdParam));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (refreshedShips?: ClientShipsResponse) => {
      if (refreshedShips) {
        setData(refreshedShips);
        return;
      }
      void loadClientShips()
        .then((response) => {
          if (!cancelled) setData(response);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };
    const handleRefresh = (event: Event) => {
      const ships = (event as CustomEvent<{ ships?: ClientShipsResponse | null }>).detail.ships;
      load(ships ?? undefined);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    load();
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const value = Number(new URLSearchParams(window.location.search).get(shipItemIdParam));
      setSelectedShipItemId(Number.isSafeInteger(value) && value > 0 ? value : null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const typeNames = useMemo<TypeName>(
    () => new Map((data?.types ?? []).map((type) => [type.typeId, type.name])),
    [data],
  );
  const assetsByItemId = useMemo(
    () => new Map((data?.assets ?? []).map((asset) => [asset.itemId, asset])),
    [data],
  );
  const shipItemIds = useMemo(
    () => new Set((data?.ships ?? []).map((ship) => ship.itemId)),
    [data],
  );
  const shipsByItemId = useMemo(
    () => new Map((data?.ships ?? []).map((ship) => [ship.itemId, ship])),
    [data],
  );
  const selectedShip = useMemo(
    () => (data?.ships ?? []).find((ship) => ship.itemId === selectedShipItemId) ?? null,
    [data, selectedShipItemId],
  );
  function selectShip(ship: ShipSummary) {
    const url = new URL(window.location.href);
    if (url.searchParams.get(shipItemIdParam) === String(ship.itemId)) return;
    url.searchParams.set(shipItemIdParam, String(ship.itemId));
    window.history.pushState({}, "", url);
    setSelectedShipItemId(ship.itemId);
  }

  function closeShipModal() {
    if (new URLSearchParams(window.location.search).has(shipItemIdParam)) {
      window.history.back();
      return;
    }
    setSelectedShipItemId(null);
  }
  const shipsBySystem = useMemo(() => {
    const buckets = new Map<
      string,
      { systemId?: number; systemName: string; ships: ShipSummary[] }
    >();
    for (const ship of data?.ships ?? []) {
      const key = ship.systemId === undefined ? `unknown:${ship.itemId}` : String(ship.systemId);
      const bucket = buckets.get(key) ?? {
        systemId: ship.systemId,
        systemName: ship.systemName ?? "Unknown system",
        ships: [],
      };
      bucket.ships.push(ship);
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort(
      (left, right) =>
        right.ships.length - left.ships.length || left.systemName.localeCompare(right.systemName),
    );
  }, [data]);

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <p className="eyebrow">FLEET INVENTORY</p>
          <h1>Ships</h1>
        </div>
        <div className={styles.shipsStats}>
          <div className={styles.shipsIndexedMetric}>
            <strong>{data?.ships?.length ?? 0}</strong>
            <span>ships indexed</span>
          </div>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" className={styles.shipsEmpty}>
          <AlertDescription>Could not load ship assets.</AlertDescription>
        </Alert>
      )}
      {!error && data && shipsBySystem.length === 0 && (
        <Empty className={styles.shipsEmpty}>
          <EmptyDescription>No ships found in the current ESI asset cache.</EmptyDescription>
        </Empty>
      )}
      <div className={styles.shipSystems}>
        {shipsBySystem.map((system) => (
          <section className={styles.shipSystem} key={system.systemId ?? system.systemName}>
            <div className={styles.shipSystemHeader}>
              <div>
                <p className={styles.panelKicker}>SYSTEM</p>
                <h2>{system.systemName}</h2>
              </div>
              <span className={styles.shipCount}>{system.ships.length} ships</span>
            </div>
            <div className={styles.shipList}>
              {system.ships.map((ship) => {
                const shipTypeName = typeNames.get(ship.typeId) ?? `Type ${ship.typeId}`;
                const shipDisplayName = ship.name ? `${ship.name} - ${shipTypeName}` : shipTypeName;
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    className={styles.shipCard}
                    key={ship.itemId}
                    onClick={() => selectShip(ship)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectShip(ship);
                      }
                    }}
                  >
                    <TypeIdentity
                      name={shipDisplayName}
                      typeId={ship.typeId}
                      variation="render"
                      imageSize={54}
                      className={styles.shipCardIdentity}
                    />
                    <span className={styles.shipCardMeta}>ITEM ID {ship.itemId}</span>
                    <span className={styles.shipCardAction}>SHIP FITTING →</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {selectedShip && (
        <ShipContentsModal
          ship={selectedShip}
          assetsByItemId={assetsByItemId}
          shipItemIds={shipItemIds}
          shipsByItemId={shipsByItemId}
          typeNames={typeNames}
          onClose={closeShipModal}
          onSelectShip={selectShip}
        />
      )}
    </>
  );
}

function ShipContentsModal({
  ship,
  assetsByItemId,
  shipItemIds,
  shipsByItemId,
  typeNames,
  onClose,
  onSelectShip,
}: {
  ship: ShipSummary;
  assetsByItemId: Map<number, ShipAsset>;
  shipItemIds: Set<number>;
  shipsByItemId: Map<number, ShipSummary>;
  typeNames: TypeName;
  onClose: () => void;
  onSelectShip: (ship: ShipSummary) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  useEffect(() => {
    modalRef.current?.scrollTo({ top: 0 });
  }, [ship.itemId]);

  const groups = new Map<string, { label: string; order: number; assets: ShipAsset[] }>();
  const containedAssets = [...assetsByItemId.values()].filter((asset) => {
    if (asset.itemId === ship.itemId) return false;
    const visited = new Set<number>();
    let current: ShipAsset | undefined = assetsByItemId.get(asset.locationId);
    let nearestShipId: number | undefined;
    while (current && !visited.has(current.itemId)) {
      if (shipItemIds.has(current.itemId)) {
        nearestShipId = current.itemId;
        break;
      }
      visited.add(current.itemId);
      current = assetsByItemId.get(current.locationId);
    }
    return nearestShipId === ship.itemId;
  });
  const weaponBySlotFlag = new Map<string, ShipAsset>();
  for (const asset of containedAssets) {
    if (!asset.isAmmo && /^(HiSlot|MedSlot|LoSlot)\d+$/.test(asset.locationFlag)) {
      weaponBySlotFlag.set(asset.locationFlag, asset);
    }
  }
  const ammoByWeaponId = new Map<number, ShipAsset[]>();
  const pairedAmmoIds = new Set<number>();
  for (const asset of containedAssets) {
    const weapon = asset.isAmmo ? weaponBySlotFlag.get(asset.locationFlag) : undefined;
    if (!weapon) continue;
    const ammo = ammoByWeaponId.get(weapon.itemId) ?? [];
    ammo.push(asset);
    ammoByWeaponId.set(weapon.itemId, ammo);
    pairedAmmoIds.add(asset.itemId);
  }
  for (const asset of containedAssets) {
    if (pairedAmmoIds.has(asset.itemId)) continue;
    const details = getAssetGroup(asset.locationFlag);
    const group = groups.get(details.key) ?? {
      label: details.label,
      order: details.order,
      assets: [],
    };
    group.assets.push(asset);
    groups.set(details.key, group);
  }
  const orderedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      assets: [...group.assets].sort((left, right) => {
        const leftSlot = getAssetGroup(left.locationFlag).slot;
        const rightSlot = getAssetGroup(right.locationFlag).slot;
        return leftSlot - rightSlot || left.itemId - right.itemId;
      }),
    }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  const shipTypeName = typeNames.get(ship.typeId) ?? `Type ${ship.typeId}`;
  const shipDisplayName = ship.name ? `${ship.name} - ${shipTypeName}` : shipTypeName;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent ref={modalRef} className={styles.shipModal}>
        <div className={styles.panelHeader}>
          <div className={styles.shipModalHeading}>
            <p className={styles.panelKicker}>SHIP FITTING</p>
            <DialogTitle>
              <TypeIdentity
                name={shipDisplayName}
                typeId={ship.typeId}
                variation="render"
                imageSize={54}
                className={styles.shipModalIdentity}
              />
            </DialogTitle>
            <p className={styles.shipModalSystem}>
              {ship.systemName ?? "Unknown system"} · ITEM ID {ship.itemId}
            </p>
          </div>
        </div>
        <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
          {orderedGroups.length === 0 ? (
            <Empty className={styles.shipsEmpty}>
              <EmptyDescription>No contained assets.</EmptyDescription>
            </Empty>
          ) : (
            <div className={styles.shipAssetGroups}>
              {orderedGroups.map((group) => (
                <section key={group.label} className={styles.shipAssetGroup}>
                  <h3>{group.label}</h3>
                  {group.assets.map((asset) => (
                    <div className={styles.shipAssetRow} key={asset.itemId}>
                      <div className={styles.shipAssetLoadout}>
                        <div className={styles.shipAssetItem}>
                          <TypeIdentity
                            name={
                              asset.name ?? typeNames.get(asset.typeId) ?? `Type ${asset.typeId}`
                            }
                            typeName={asset.name ? typeNames.get(asset.typeId) : undefined}
                            typeId={asset.typeId}
                            imageSize={32}
                          />
                          {asset.quantity > 1 && (
                            <span className={styles.shipAssetQuantity}>
                              ×{asset.quantity.toLocaleString()}
                            </span>
                          )}
                        </div>
                        {(ammoByWeaponId.get(asset.itemId) ?? []).map((ammo) => (
                          <div className={styles.shipAssetItem} key={ammo.itemId}>
                            <TypeIdentity
                              name={
                                ammo.name ?? typeNames.get(ammo.typeId) ?? `Type ${ammo.typeId}`
                              }
                              typeName={ammo.name ? typeNames.get(ammo.typeId) : undefined}
                              typeId={ammo.typeId}
                              imageSize={32}
                            />
                            {ammo.quantity > 1 && (
                              <span className={styles.shipAssetQuantity}>
                                ×{ammo.quantity.toLocaleString()}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      {shipsByItemId.has(asset.itemId) && (
                        <button
                          type="button"
                          className={`actionButton ${styles.importButton}`}
                          title="View ship fitting"
                          onClick={() => {
                            const nestedShip = shipsByItemId.get(asset.itemId);
                            if (nestedShip) onSelectShip(nestedShip);
                          }}
                        >
                          <span>VIEW FITTING</span>
                          <ArrowRight aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
