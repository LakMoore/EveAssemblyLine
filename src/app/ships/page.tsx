"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import FittingContents from "@/components/FittingContents";
import { Button } from "@/components/ui/button";
import { loadClientShips, type ClientShipsResponse } from "@/lib/client/requestCache";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import styles from "../page.module.css";
import { ArrowRight } from "lucide-react";
import ResponsiveDialogDrawer from "@/components/ResponsiveDialogDrawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";

type ShipSummary = NonNullable<ClientShipsResponse["ships"]>[number];
type TypeName = Map<number, string>;
const shipItemIdParam = "shipItemId";
const shipThumbnailSize = 54;

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
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const typeNames = useMemo<TypeName>(
    () => new Map((data?.types ?? []).map((type) => [type.typeId, type.name])),
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
  const shipsInSpace = useMemo(
    () =>
      (data?.ships ?? [])
        .filter(
          (ship): ship is ShipSummary & { pilotId: number; pilotName: string } =>
            ship.isInSpace === true && ship.pilotId !== undefined && ship.pilotName !== undefined,
        )
        .sort((left, right) => left.pilotName.localeCompare(right.pilotName)),
    [data],
  );
  const shipsBySystem = useMemo(() => {
    const buckets = new Map<
      string,
      { key: string; systemId?: number; systemName: string; ships: ShipSummary[] }
    >();
    for (const ship of data?.ships ?? []) {
      if (ship.isInSpace) continue;
      const key = ship.systemId === undefined ? `unknown:${ship.itemId}` : String(ship.systemId);
      const bucket = buckets.get(key) ?? {
        key,
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
      {!error && data && shipsInSpace.length === 0 && shipsBySystem.length === 0 && (
        <Empty className={styles.shipsEmpty}>
          <EmptyDescription>No ships found in the current ESI asset cache.</EmptyDescription>
        </Empty>
      )}
      {shipsInSpace.length > 0 && (
        <section className={styles.shipsInSpaceSection}>
          <div className={styles.shipSystemHeader}>
            <div>
              <p className={styles.panelKicker}>ACTIVE PILOTS</p>
              <h2>Ships in Space</h2>
            </div>
            <span className={styles.shipCount}>{shipsInSpace.length} active</span>
          </div>
          <div className={styles.shipsInSpaceList}>
            {shipsInSpace.map((ship) => {
              const shipTypeName = typeNames.get(ship.typeId) ?? `Type ${ship.typeId}`;
              const shipDisplayName = ship.name ? `${ship.name} - ${shipTypeName}` : shipTypeName;
              return (
                <article className={styles.shipInSpaceCard} key={ship.itemId}>
                  <div className={styles.shipPilotIdentity}>
                    <Image
                      src={eveCharacterPortraitUrl(ship.pilotId, 64)}
                      alt={`${ship.pilotName} portrait`}
                      width={shipThumbnailSize}
                      height={shipThumbnailSize}
                    />
                    <div>
                      <span>PILOT</span>
                      <strong>{ship.pilotName}</strong>
                    </div>
                  </div>
                  <TypeIdentity
                    name={shipDisplayName}
                    typeName={ship.name ? shipTypeName : undefined}
                    typeId={ship.typeId}
                    variation="render"
                    imageSize={shipThumbnailSize}
                    className={styles.shipInSpaceIdentity}
                  />
                  <div className={styles.shipInSpaceLocation}>
                    <h3>{ship.systemName ?? "Unknown system"} &laquo;Undocked&raquo;</h3>
                    <small>ITEM ID {ship.itemId}</small>
                  </div>
                  <a
                    href={`/ships?${shipItemIdParam}=${ship.itemId}`}
                    className={`actionButton ${styles.shipInSpaceAction}`}
                    onClick={(event) => {
                      event.preventDefault();
                      selectShip(ship);
                    }}
                  >
                    <span>VIEW FITTING</span>
                    <ArrowRight aria-hidden="true" />
                  </a>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <div className={styles.shipSystems}>
        {shipsBySystem.map((system) => (
          <section className={styles.shipSystem} key={system.key}>
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
                    onClick={() => {
                      selectShip(ship);
                    }}
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
                      typeName={ship.name ? shipTypeName : undefined}
                      typeId={ship.typeId}
                      variation="render"
                      imageSize={shipThumbnailSize}
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
  shipsByItemId,
  typeNames,
  onClose,
  onSelectShip,
}: {
  ship: ShipSummary;
  shipsByItemId: Map<number, ShipSummary>;
  typeNames: TypeName;
  onClose: () => void;
  onSelectShip: (ship: ShipSummary) => void;
}) {
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  const itemsByItemId = new Map(ship.items.map((item) => [item.itemId, item]));
  const shipItemIds = new Set(shipsByItemId.keys());
  const containedAssets = ship.items.filter((asset) => {
    const visited = new Set<number>();
    let locationId = asset.locationId;
    while (!visited.has(locationId)) {
      if (locationId === ship.itemId) return true;
      if (shipItemIds.has(locationId)) return false;
      visited.add(locationId);
      const parent = itemsByItemId.get(locationId);
      if (!parent) return false;
      locationId = parent.locationId;
    }
    return false;
  });
  const shipTypeName = typeNames.get(ship.typeId) ?? `Type ${ship.typeId}`;
  const shipDisplayName = ship.name ? `${ship.name} - ${shipTypeName}` : shipTypeName;

  return (
    <ResponsiveDialogDrawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dialogClassName={styles.shipModal}
      drawerClassName={styles.shipModal}
      title={
        <div className={styles.panelHeader}>
          <div className={styles.shipModalHeading}>
            <p className={styles.panelKicker}>SHIP FITTING</p>
            <TypeIdentity
              name={shipDisplayName}
              typeName={ship.name ? shipTypeName : undefined}
              typeId={ship.typeId}
              variation="render"
              imageSize={54}
              className={styles.shipModalIdentity}
            />
            <p className={styles.shipModalSystem}>
              {ship.systemName ?? "Unknown system"} · ITEM ID {ship.itemId}
            </p>
          </div>
        </div>
      }
    >
      <FittingContents
        items={containedAssets}
        typeNames={typeNames}
        renderItemAction={(asset) => {
          const nestedShip = shipsByItemId.get(asset.itemId);
          return nestedShip ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onSelectShip(nestedShip);
              }}
            >
              <ArrowRight data-icon="inline-start" />
              View fitting
            </Button>
          ) : null;
        }}
      />
    </ResponsiveDialogDrawer>
  );
}
