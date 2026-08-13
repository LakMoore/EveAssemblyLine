"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GitMerge, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { languageStorageKey } from "../AppShell";
import { replaceEsiStock, replaceMarketOrderStock } from "@/lib/planning/stockStore";
import { defaultSettings, settingsStorageKey } from "@/lib/planning/preferences";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { eveCharacterPortraitUrl, eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import {
  invalidateClientCharacterData,
  clearClientStockCache,
  loadClientCharacters,
  loadClientCorpStatus,
  loadClientMarketOrders,
  loadClientStateStatus,
  loadClientStock,
  type ClientCharacter,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import styles from "../page.module.css";

type Character = ClientCharacter;

type MergeDetails = {
  incomingCharacter: { characterId: number; characterName: string };
  currentCharacters: Array<{ characterId: number; characterName: string }>;
  incomingCharacters: Array<{ characterId: number; characterName: string }>;
};

type EndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
  hasBody: boolean;
  lastUpdated?: string;
  lastModified?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
};

type CharacterStatus = ClientCharacterStatus;

function formatDate(value?: string) {
  if (!value) return "Not refreshed";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderedStatus(status: EndpointStatus | undefined): EndpointStatus | undefined {
  if (!status || status.status === "error" || status.status === "rate_limited") return status;
  const expiresAt = Date.parse(status.expires ?? status.nextRefreshAllowed ?? "");
  const modifiedAt = Date.parse(status.lastModified ?? "");
  const now = Date.now();
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { ...status, status: "stale" };
  const recentlyModified = Number.isFinite(modifiedAt) && modifiedAt <= now && now - modifiedAt <= 2 * 60 * 1000;
  if (recentlyModified) {
    return { ...status, status: "fresh" };
  }
  return { ...status, status: "cached" };
}

function statusLabel(status: EndpointStatus | undefined, noAccess = false) {
  if (noAccess) return "No Access";
  const currentStatus = renderedStatus(status);
  if (currentStatus?.status === "error") return "Reauthorize required";
  if (!currentStatus || !currentStatus.hasBody) return "Unknown";
  if (
    currentStatus.status !== "rate_limited" &&
    !currentStatus.lastUpdated &&
    !currentStatus.expires &&
    !currentStatus.nextRefreshAllowed
  ) return "Refresh required";
  if (currentStatus.status === "fresh") return "Fresh";
  if (currentStatus.status === "stale") return "Stale";
  if (currentStatus.status === "rate_limited") return "Rate limited";
  return "Cached";
}

function statusClass(status: EndpointStatus | undefined) {
  const currentStatus = renderedStatus(status);
  if (!currentStatus || !currentStatus.hasBody) return styles.statusError;
  if (currentStatus?.status === "fresh") return styles.statusFresh;
  if (currentStatus?.status === "stale") return styles.statusError;
  if (currentStatus?.status === "rate_limited" || currentStatus?.status === "error") return styles.statusError;
  return styles.statusCached;
}

function availabilityLabel(status?: EndpointStatus) {
  if (!status) return "Not loaded";
  if (status.status === "error") return "Refresh failed";
  if (status.status === "rate_limited" && status.rateLimitedUntil) {
    return `Available ${formatDate(status.rateLimitedUntil)}`;
  }
  if (!status.expires && !status.nextRefreshAllowed) return "Refresh required";
  if (!status.lastUpdated && !status.nextRefreshAllowed) return "Refresh required";
  const blockedUntil = status.rateLimitedUntil ?? status.nextRefreshAllowed;
  if (blockedUntil && Date.parse(blockedUntil) > Date.now()) {
    return `Available ${formatDate(blockedUntil)}`;
  }
  return "Available now";
}

function roleLabel(hasRole: boolean) {
  return hasRole ? "Yes" : "No";
}

function missingScopes(statuses: CharacterStatus[]) {
  return [...new Set(statuses.flatMap((character) => [
    character.assets?.error,
    character.jobs?.error,
    character.orders?.error,
    ...(character.corporations ?? []).flatMap((corporation) => [
      corporation.assets?.error,
      corporation.jobs?.error,
      corporation.orders?.error,
    ]),
  ]).flatMap((error) => {
    const match = error?.match(/scope: (esi-[^\s]+)/i);
    return match ? [match[1]] : [];
  }))];
}

async function refreshStockAfterCharacterRemoval() {
  const savedLanguage = window.localStorage.getItem(languageStorageKey);
  const language: SdeLanguage = isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  const response = await fetch("/api/state/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (response.status === 401) {
    clearClientStockCache(language);
    await replaceEsiStock([]);
    await replaceMarketOrderStock([]);
    window.dispatchEvent(
      new CustomEvent("assembly-line-esi-refreshed", { detail: { stockLocations: [] } }),
    );
    return;
  }
  if (!response.ok) throw new Error("Could not refresh stock.");

  const stockData = await loadClientStock(language, true);
  const stockLocations = stockData.locations ?? [];
  await replaceEsiStock(
    stockLocations.map((location) => ({
      systemId: location.systemId ?? 0,
      systemName: location.systemName ?? "Unknown system",
      structureId: String(location.locationId),
      structureName: location.name,
      source: "esi" as const,
      items: location.items,
    })),
  );
  let settings = defaultSettings;
  try {
    const savedSettings = window.localStorage.getItem(settingsStorageKey);
    settings = savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings) } : defaultSettings;
  } catch {
  }
  const marketOrders = await loadClientMarketOrders(settings);
  await replaceMarketOrderStock(marketOrders?.marketOrderStock ?? []);
  window.dispatchEvent(
    new CustomEvent("assembly-line-esi-refreshed", { detail: { stockLocations } }),
  );
}

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [statuses, setStatuses] = useState<CharacterStatus[]>([]);
  const [, setFreshnessTick] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedCorporationId, setSelectedCorporationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeDetails, setMergeDetails] = useState<MergeDetails | null>(null);
  const [isMerging, setIsMerging] = useState(false);

  async function loadCharacters() {
    const [loaded, corpStatus] = await Promise.all([loadClientCharacters(), loadClientCorpStatus()]);
    const corpById = new Map(corpStatus.map((character) => [character.characterId, character]));
    setCharacters(loaded.map((character) => ({ ...character, ...corpById.get(character.characterId) })));
  }

  async function loadStatuses(force = false) {
    const data = await loadClientStateStatus(force);
    setStatuses(data.characters ?? []);
    setFreshnessTick((tick) => tick + 1);
  }

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([loadCharacters(), loadStatuses()]))
      .catch(() => setError("Could not reach the character service."))
      .finally(() => setIsLoading(false));
    const freshnessTimer = window.setInterval(() => setFreshnessTick((tick) => tick + 1), 5_000);
    const handleRefresh = () => void loadStatuses(true);
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => {
      window.clearInterval(freshnessTimer);
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("merge")) return;
    void fetch("/api/auth/merge")
      .then((response) => response.json() as Promise<{ mergeRequired?: boolean } & Partial<MergeDetails>>)
      .then((data) => {
        if (data.mergeRequired && data.incomingCharacter && data.currentCharacters && data.incomingCharacters) {
          setMergeDetails({ incomingCharacter: data.incomingCharacter, currentCharacters: data.currentCharacters, incomingCharacters: data.incomingCharacters });
        }
      })
      .catch(() => setError("Could not load the character collection merge request."));
  }, []);

  async function confirmMerge() {
    setIsMerging(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/merge", { method: "POST" });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not merge character collections.");
      }
      window.location.assign("/characters?refresh=1");
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Could not merge character collections.");
      setIsMerging(false);
    }
  }

  useEffect(() => {
    if (!selectedCharacter && selectedCorporationId === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCharacter(null);
        setSelectedCorporationId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCharacter, selectedCorporationId]);

  async function removeCharacter(character: Character) {
    if (!window.confirm(`Remove ${character.characterName} from this session?`)) return;
    setRemovingId(character.characterId);
    setError(null);
    try {
      const response = await fetch(`/api/characters/${character.characterId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not remove character.");
      }
      setCharacters((current) => current.filter((entry) => entry.characterId !== character.characterId));
      setStatuses((current) => current.filter((entry) => entry.characterId !== character.characterId));
      invalidateClientCharacterData();
      try {
        await refreshStockAfterCharacterRemoval();
      } catch {
        setError("Character removed, but stock could not be refreshed.");
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove character.");
    } finally {
      setRemovingId(null);
    }
  }

  const corporations = [...new Set(characters.map((character) => character.corporationId).filter(Boolean))].map((corporationId) => {
    const pilots = characters.filter((character) => character.corporationId === corporationId);
    const eligible = pilots.filter((character) => character.hasDirectorRole);
    const corpStatuses = pilots.flatMap((pilot) => statuses.find((status) => status.characterId === pilot.characterId)?.corporations ?? []).filter((status) => status.corporationId === corporationId);
    return { corporationId: corporationId!, corporationName: pilots[0]?.corporationName, pilots, eligible, status: corpStatuses[0]?.assets };
  });
  const scopes = missingScopes(statuses);
  const hasAuthorizationErrors = statuses.some((status) => [
    status.assets,
    status.jobs,
    status.orders,
    ...(status.corporations ?? []).flatMap((corporation) => [
      corporation.assets,
      corporation.jobs,
      corporation.orders,
    ]),
  ].some((endpoint) => endpoint?.status === "error"));

  return (
    <>
      <div className={styles.pageIntro}>
        <div><p className={styles.eyebrow}>CONFIGURATION / ACCESS</p><h1>Characters</h1><p className={styles.subtitle}>Manage the pilots available to the planner and verify corporation access.</p></div>
        <Link className={`actionButton ${styles.addButton}`} href="/api/auth/eve/start">
          <Plus aria-hidden="true" />
          <span>Add character</span>
        </Link>
      </div>
      {error && <p role="alert" className={styles.importError}>{error}</p>}
      {hasAuthorizationErrors && <p role="alert" className={styles.importError}>EVE authorization has expired for one or more connected characters. Reauthorize the affected character to restore assets, jobs, and orders. <Link href="/api/auth/eve/start">Reauthorize character</Link></p>}
      {scopes.length > 0 && <p role="alert" className={styles.importError}>EVE authorization is missing {scopes.join(", ")}. Reconnect the affected character to grant this scope.</p>}
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.panelKicker}>01 / CONNECTED PILOTS</p><h2>{isLoading ? "Loading characters..." : `${characters.length} connected`}</h2></div>
          <span className={styles.panelDescription}>Use Refresh data in the top bar to update all connected pilots.</span>
        </div>
        {!isLoading && characters.length === 0 ? (
          <div className={styles.emptyBuildList}><strong>No characters connected</strong><p>Connect an EVE character to make assets, jobs, and corporation access available.</p><Link className={`actionButton ${styles.addButton}`} href="/api/auth/eve/start"><Plus aria-hidden="true" /><span>Connect with EVE SSO</span></Link></div>
        ) : (
          <>
            <div className={styles.characterTableHeader}><span>PILOT</span><span>ASSETS</span><span>JOBS</span><span>ORDERS</span><span /></div>
            {characters.map((character) => {
              const status = statuses.find((entry) => entry.characterId === character.characterId);
              const hasAuthorizationError = [
                status?.assets,
                status?.jobs,
                status?.orders,
                ...(status?.corporations ?? []).flatMap((corporation) => [
                  corporation.assets,
                  corporation.jobs,
                  corporation.orders,
                ]),
              ].some((endpoint) => endpoint?.status === "error");
              const hasCorpAccess = character.hasDirectorRole;
              return <div
                className={`${styles.characterRow} ${hasAuthorizationError ? styles.characterRowWithReauthorize : ""}`}
                key={character.characterId}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedCharacter(character)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedCharacter(character);
                  }
                }}
              >
                <span className={styles.characterIdentity}>
                  <strong>{character.characterName}</strong>
                  <small>{character.corporationName ?? (character.corporationId ? `Corporation ${character.corporationId}` : "Corporation unavailable")} / {hasCorpAccess ? "Director access" : "Character access only"}</small>
                  <small>Director: {roleLabel(character.hasDirectorRole)} · Accountant: {roleLabel(character.hasAccountantRole)} · Trader: {roleLabel(character.hasTraderRole)}</small>
                </span>
                <span className={styles.statusCell} title={`Assets: ${availabilityLabel(status?.assets)}${status?.assets?.error ? `; ${status.assets.error}` : ""}${status?.assets?.lastModified ? `; modified ${formatDate(status.assets.lastModified)}` : ""}`}><small className={styles.endpointName}>ASSETS</small><span className={`${styles.statusDot} ${statusClass(status?.assets)}`} /><small className={styles.endpointState}>{statusLabel(status?.assets)}</small><small className={styles.statusDate}><span className={styles.availabilityWide}>{availabilityLabel(status?.assets)}</span><span className={styles.availabilityNarrow}>{availabilityLabel(status?.assets).replace(/^Available /, "")}</span></small></span>
                  <span className={styles.statusCell} title={`Jobs: ${availabilityLabel(status?.jobs)}${status?.jobs?.error ? `; ${status.jobs.error}` : ""}${status?.jobs?.lastModified ? `; modified ${formatDate(status.jobs.lastModified)}` : ""}`}><small className={styles.endpointName}>JOBS</small><span className={`${styles.statusDot} ${statusClass(status?.jobs)}`} /><small className={styles.endpointState}>{statusLabel(status?.jobs)}</small><small className={styles.statusDate}><span className={styles.availabilityWide}>{availabilityLabel(status?.jobs)}</span><span className={styles.availabilityNarrow}>{availabilityLabel(status?.jobs).replace(/^Available /, "")}</span></small></span>
                  <span className={styles.statusCell} title={`Orders: ${availabilityLabel(status?.orders)}${status?.orders?.error ? `; ${status.orders.error}` : ""}${status?.orders?.lastModified ? `; modified ${formatDate(status.orders.lastModified)}` : ""}`}><small className={styles.endpointName}>ORDERS</small><span className={`${styles.statusDot} ${statusClass(status?.orders)}`} /><small className={styles.endpointState}>{statusLabel(status?.orders)}</small><small className={styles.statusDate}><span className={styles.availabilityWide}>{availabilityLabel(status?.orders)}</span><span className={styles.availabilityNarrow}>{availabilityLabel(status?.orders).replace(/^Available /, "")}</span></small></span>
                <span className={styles.characterActions}>
                  {hasAuthorizationError && <button
                    type="button"
                    className={`actionButton ${styles.characterReauthorize}`}
                    onClick={(event) => { event.stopPropagation(); window.location.assign("/api/auth/eve/start"); }}
                    aria-label={`Re-authorise ${character.characterName}`}
                    title="Re-authorise character"
                  >
                    <RotateCcw aria-hidden="true" strokeWidth={1.8} />
                    <span>Re-authorise</span>
                  </button>}
                  <button
                    type="button"
                    className={`actionButton ${styles.characterRemove}`}
                    onClick={(event) => { event.stopPropagation(); void removeCharacter(character); }}
                    disabled={removingId === character.characterId}
                    aria-label={removingId === character.characterId ? "Removing character" : `Remove ${character.characterName}`}
                    title={removingId === character.characterId ? "Removing character" : "Remove character"}
                  >
                    <Trash2 aria-hidden="true" strokeWidth={1.8} />
                    <span>{removingId === character.characterId ? "Removing..." : "Remove"}</span>
                  </button>
                </span>
              </div>;
            })}
          </>
        )}
      </section>
      {selectedCharacter && (() => {
        const selectedStatus = statuses.find((entry) => entry.characterId === selectedCharacter.characterId);
        const hasCorpAccess = selectedCharacter.hasDirectorRole;
        return <div className={styles.modalBackdrop} onClick={() => setSelectedCharacter(null)}>
          <div className={styles.importModal} role="dialog" aria-modal="true" aria-labelledby="character-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}>
              <div className={styles.characterModalHeading}><img className={styles.characterPortrait} src={eveCharacterPortraitUrl(selectedCharacter.characterId)} alt="" /><div><p className={styles.panelKicker}>CHARACTER DETAILS</p><h2 id="character-dialog-title">{selectedCharacter.characterName}</h2></div></div>
              <button type="button" className={`actionButton ${styles.importButton}`} onClick={() => setSelectedCharacter(null)} aria-label="Close character details"><X aria-hidden="true" /><span>Close</span></button>
            </div>
            <div className={styles.characterModalIdentity}>
              <strong className={styles.characterModalCorporation}>{selectedCharacter.corporationId && <img className={styles.characterCorporationLogo} src={eveCorporationLogoUrl(selectedCharacter.corporationId)} alt="" />}<span>{selectedCharacter.corporationName ?? (selectedCharacter.corporationId ? `Corporation ${selectedCharacter.corporationId}` : "Corporation unavailable")}</span></strong>
              <small>{hasCorpAccess ? "Director access" : "Character access only"}</small>
              <small>Director: {roleLabel(selectedCharacter.hasDirectorRole)} · Accountant: {roleLabel(selectedCharacter.hasAccountantRole)} · Trader: {roleLabel(selectedCharacter.hasTraderRole)}</small>
            </div>
            <div className={styles.characterModalStatuses}>
              {(["assets", "jobs", "orders"] as const).map((endpoint) => {
                const endpointStatus = selectedStatus?.[endpoint];
                return <div className={styles.characterModalStatus} key={endpoint}>
                  <small>{endpoint.toUpperCase()}</small>
                  <span><span className={`${styles.statusDot} ${statusClass(endpointStatus)}`} />{statusLabel(endpointStatus)}</span>
                  <small>{availabilityLabel(endpointStatus)}</small>
                  {endpointStatus?.lastModified && <small>Modified {formatDate(endpointStatus.lastModified)}</small>}
                  {endpointStatus?.error && <small>{endpointStatus.error}</small>}
                </div>;
              })}
            </div>
            <div className={styles.characterModalRoles}>
              <p className={styles.panelKicker}>CORPORATION ROLES</p>
              <div>{selectedCharacter.corporationRoles.length > 0 ? selectedCharacter.corporationRoles.join(", ") : "No corporation roles reported"}</div>
            </div>
          </div>
        </div>;
      })()}
      {mergeDetails && <div className={styles.modalBackdrop} onClick={() => window.location.assign("/characters")}>
        <div className={`${styles.importModal} ${styles.mergeModal}`} role="dialog" aria-modal="true" aria-labelledby="merge-dialog-title" onClick={(event) => event.stopPropagation()}>
          <div className={styles.panelHeader}>
            <div><p className={styles.panelKicker}>ACCOUNT COLLECTION MERGE</p><h2 id="merge-dialog-title">Merge character collections?</h2></div>
            <button type="button" className={`actionButton ${styles.mergeCloseButton}`} onClick={() => window.location.assign("/characters")} aria-label="Cancel collection merge" title="Cancel collection merge"><X aria-hidden="true" /></button>
          </div>
          <p className={styles.mergeLead}>The authenticated character belongs to another collection. Merge them to make both collections available in every linked session.</p>
          <div className={styles.mergeCollections}>
            <div className={styles.mergeCollection}>
              <p className={styles.panelKicker}>THIS SESSION</p>
              <div className={styles.mergePortraits}>
                {mergeDetails.currentCharacters.map((character) => <div className={styles.mergeCharacter} key={character.characterId}>
                  <img className={styles.mergePortrait} src={eveCharacterPortraitUrl(character.characterId)} alt="" />
                  <span>{character.characterName}</span>
                </div>)}
              </div>
            </div>
            <div className={styles.mergeDivider} aria-hidden="true">+</div>
            <div className={styles.mergeCollection}>
              <p className={styles.panelKicker}>OTHER COLLECTION</p>
              <div className={styles.mergePortraits}>
                {mergeDetails.incomingCharacters.map((character) => <div className={styles.mergeCharacter} key={character.characterId}>
                  <img className={styles.mergePortrait} src={eveCharacterPortraitUrl(character.characterId)} alt="" />
                  <span>{character.characterName}</span>
                </div>)}
              </div>
            </div>
          </div>
          <div className={styles.mergeNote}><strong>{mergeDetails.incomingCharacter.characterName}</strong> will be added to this session.</div>
          <div className={styles.actionRow}>
            <button type="button" className={`actionButton ${styles.mergeCancelButton}`} onClick={() => window.location.assign("/characters")} disabled={isMerging}><X aria-hidden="true" /><span>Cancel</span></button>
            <button type="button" className={`actionButton ${styles.mergeConfirmButton}`} onClick={() => void confirmMerge()} disabled={isMerging}><GitMerge aria-hidden="true" /><span>{isMerging ? "Merging..." : "Merge collections"}</span></button>
          </div>
        </div>
      </div>}
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><p className={styles.panelKicker}>02 / CORPORATION ACCESS</p><h2>Eligibility</h2></div></div>
        <p className={styles.panelDescription}>Corporation assets are available when at least one connected pilot has a verified Director role and the required corporation scopes.</p>
        {corporations.length === 0 ? <p className={styles.emptyBuildList}>No corporation information is available yet.</p> : <div className={styles.eligibilityList}>{corporations.map((corporation) => {
          const corporationStatus = statuses.flatMap((status) => status.corporations ?? []).find((status) => status.corporationId === corporation.corporationId);
          return <div
            className={styles.eligibilityRow}
            key={corporation.corporationId}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedCorporationId(corporation.corporationId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedCorporationId(corporation.corporationId);
              }
            }}
          ><span><strong>{corporation.corporationName ?? `Corporation ${corporation.corporationId}`}</strong><small>{corporation.pilots.map((pilot) => pilot.characterName).join(" · ")}</small></span><span className={styles.endpointList}><span className={styles.endpointHeaders}><small>ASSETS</small><small>JOBS</small><small>ORDERS</small></span>{(["assets", "jobs", "orders"] as const).map((endpoint) => { const endpointStatus = corporationStatus?.[endpoint]; return <span className={styles.endpointStatus} key={endpoint}><small className={styles.endpointName}>{endpoint.toUpperCase()}</small><span className={`${styles.statusDot} ${statusClass(endpointStatus)}`} /><small className={styles.endpointState}>{statusLabel(endpointStatus, corporation.eligible.length === 0)}</small><small className={styles.endpointAvailability}><span className={styles.availabilityWide}>{availabilityLabel(endpointStatus)}</span><span className={styles.availabilityNarrow}>{availabilityLabel(endpointStatus).replace(/^Available /, "")}</span></small></span>; })}</span></div>;
        })}</div>}
      </section>
      {selectedCorporationId !== null && (() => {
        const corporation = corporations.find((entry) => entry.corporationId === selectedCorporationId);
        if (!corporation) return null;
        const corporationStatus = statuses.flatMap((status) => status.corporations ?? []).find((status) => status.corporationId === selectedCorporationId);
        return <div className={styles.modalBackdrop} onClick={() => setSelectedCorporationId(null)}>
          <div className={styles.importModal} role="dialog" aria-modal="true" aria-labelledby="corporation-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}>
              <div className={styles.corporationModalHeading}><p className={styles.panelKicker}>CORPORATION DETAILS</p><div className={styles.corporationModalIdentityHeading}><img className={styles.characterPortrait} src={eveCorporationLogoUrl(corporation.corporationId)} alt="" /><h2 id="corporation-dialog-title">{corporation.corporationName ?? `Corporation ${corporation.corporationId}`}</h2></div></div>
              <button type="button" className={`actionButton ${styles.importButton}`} onClick={() => setSelectedCorporationId(null)} aria-label="Close corporation details"><X aria-hidden="true" /><span>Close</span></button>
            </div>
            <div className={styles.characterModalIdentity}>
              <strong>{corporation.eligible.length > 0 ? "Director access available" : "Director access required"}</strong>
              <small>{corporation.pilots.length} connected pilot{corporation.pilots.length === 1 ? "" : "s"}</small>
            </div>
            <div className={styles.characterModalStatuses}>
              {(["assets", "jobs", "orders"] as const).map((endpoint) => {
                const endpointStatus = corporationStatus?.[endpoint];
                return <div className={styles.characterModalStatus} key={endpoint}>
                  <small>{endpoint.toUpperCase()}</small>
                  <span><span className={`${styles.statusDot} ${statusClass(endpointStatus)}`} />{statusLabel(endpointStatus, corporation.eligible.length === 0)}</span>
                  <small>{availabilityLabel(endpointStatus)}</small>
                  {endpointStatus?.lastModified && <small>Modified {formatDate(endpointStatus.lastModified)}</small>}
                  {endpointStatus?.error && <small>{endpointStatus.error}</small>}
                </div>;
              })}
            </div>
            <div className={styles.characterModalRoles}>
              <p className={styles.panelKicker}>CONNECTED PILOTS AND ROLES</p>
              {corporation.pilots.map((pilot) => <div className={styles.corporationPilot} key={pilot.characterId}>
                <img className={styles.corporationPilotPortrait} src={eveCharacterPortraitUrl(pilot.characterId)} alt="" />
                <div><strong>{pilot.characterName}</strong><br />{pilot.corporationRoles.length > 0 ? pilot.corporationRoles.join(", ") : "No corporation roles reported"}</div>
              </div>)}
            </div>
          </div>
        </div>;
      })()}
    </>
  );
}
