"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "../AppShell";
import { eveCharacterPortraitUrl, eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import {
  invalidateClientCharacterData,
  loadClientCharacters,
  loadClientCorpStatus,
  loadClientStateStatus,
  type ClientCharacter,
  type ClientCharacterStatus,
} from "@/lib/client/requestCache";
import styles from "../page.module.css";

type Character = ClientCharacter;

type EndpointStatus = {
  status: "fresh" | "cached" | "stale" | "rate_limited" | "error";
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

function renderedStatus(status: EndpointStatus | undefined, renderedAt: number): EndpointStatus | undefined {
  if (!status || status.status === "error" || status.status === "rate_limited") return status;
  const expiresAt = Date.parse(status.expires ?? status.nextRefreshAllowed ?? "");
  const modifiedAt = Date.parse(status.lastModified ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= renderedAt) return { ...status, status: "stale" };
  const recentlyModified = Number.isFinite(modifiedAt) && modifiedAt <= renderedAt && renderedAt - modifiedAt <= 2 * 60 * 1000;
  if (recentlyModified) {
    return { ...status, status: "fresh" };
  }
  return { ...status, status: "cached" };
}

function statusLabel(status: EndpointStatus | undefined, renderedAt: number) {
  const currentStatus = renderedStatus(status, renderedAt);
  if (!currentStatus) return "No data";
  if (currentStatus.status === "fresh") return "Fresh";
  if (currentStatus.status === "stale") return "Stale";
  if (currentStatus.status === "rate_limited") return "Rate limited";
  if (currentStatus.status === "error") return "Error";
  return "Cached";
}

function statusClass(status: EndpointStatus | undefined, renderedAt: number) {
  const currentStatus = renderedStatus(status, renderedAt);
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

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [statuses, setStatuses] = useState<CharacterStatus[]>([]);
  const [renderedAt] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedCorporationId, setSelectedCorporationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCharacters() {
    const [loaded, corpStatus] = await Promise.all([loadClientCharacters(), loadClientCorpStatus()]);
    const corpById = new Map(corpStatus.map((character) => [character.characterId, character]));
    setCharacters(loaded.map((character) => ({ ...character, ...corpById.get(character.characterId) })));
  }

  async function loadStatuses(force = false) {
    const data = await loadClientStateStatus(force);
    setStatuses(data.characters ?? []);
  }

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([loadCharacters(), loadStatuses()]))
      .catch(() => setError("Could not reach the character service."))
      .finally(() => setIsLoading(false));
    const handleRefresh = () => void loadStatuses(true);
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, []);

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
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove character.");
    } finally {
      setRemovingId(null);
    }
  }

  const corporations = [...new Set(characters.map((character) => character.corporationId).filter(Boolean))].map((corporationId) => {
    const pilots = characters.filter((character) => character.corporationId === corporationId);
    const eligible = pilots.filter((character) => character.corpAuthCompleted && character.hasDirectorRole);
    const corpStatuses = pilots.flatMap((pilot) => statuses.find((status) => status.characterId === pilot.characterId)?.corporations ?? []).filter((status) => status.corporationId === corporationId);
    return { corporationId: corporationId!, corporationName: pilots[0]?.corporationName, pilots, eligible, status: corpStatuses[0]?.assets };
  });

  return (
    <AppShell activePage="characters">
      <div className={styles.pageIntro}>
        <div><p className={styles.eyebrow}>CONFIGURATION / ACCESS</p><h1>Characters</h1><p className={styles.subtitle}>Manage the pilots available to the planner and verify corporation access.</p></div>
        <Link className={styles.addButton} href="/api/auth/eve/start">+ Add character</Link>
      </div>
      {error && <p role="alert" className={styles.importError}>{error}</p>}
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.panelKicker}>01 / CONNECTED PILOTS</p><h2>{isLoading ? "Loading characters..." : `${characters.length} connected`}</h2></div>
          <span className={styles.panelDescription}>Use Refresh data in the top bar to update all connected pilots.</span>
        </div>
        {!isLoading && characters.length === 0 ? (
          <div className={styles.emptyBuildList}><strong>No characters connected</strong><p>Connect an EVE character to make assets, jobs, and corporation access available.</p><Link className={styles.addButton} href="/api/auth/eve/start">Connect with EVE SSO</Link></div>
        ) : (
          <>
            <div className={styles.characterTableHeader}><span>PILOT</span><span>ASSETS</span><span>JOBS</span><span>ORDERS</span><span /></div>
            {characters.map((character) => {
              const status = statuses.find((entry) => entry.characterId === character.characterId);
              const hasCorpAccess = character.corpAuthCompleted && character.hasDirectorRole;
              return <div
                className={styles.characterRow}
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
                <span className={styles.statusCell} data-label="Assets" title={`Assets: ${availabilityLabel(status?.assets)}${status?.assets?.error ? `; ${status.assets.error}` : ""}${status?.assets?.lastModified ? `; modified ${formatDate(status.assets.lastModified)}` : ""}`}><span className={`${styles.statusDot} ${statusClass(status?.assets, renderedAt)}`} /><small>{statusLabel(status?.assets, renderedAt)}</small><small className={styles.statusDate}>{availabilityLabel(status?.assets)}</small></span>
                  <span className={styles.statusCell} data-label="Jobs" title={`Jobs: ${availabilityLabel(status?.jobs)}${status?.jobs?.error ? `; ${status.jobs.error}` : ""}${status?.jobs?.lastModified ? `; modified ${formatDate(status.jobs.lastModified)}` : ""}`}><span className={`${styles.statusDot} ${statusClass(status?.jobs, renderedAt)}`} /><small>{statusLabel(status?.jobs, renderedAt)}</small><small className={styles.statusDate}>{availabilityLabel(status?.jobs)}</small></span>
                  <span className={styles.statusCell} data-label="Orders" title={`Orders: ${availabilityLabel(status?.orders)}${status?.orders?.error ? `; ${status.orders.error}` : ""}${status?.orders?.lastModified ? `; modified ${formatDate(status.orders.lastModified)}` : ""}`}><span className={`${styles.statusDot} ${statusClass(status?.orders, renderedAt)}`} /><small>{statusLabel(status?.orders, renderedAt)}</small><small className={styles.statusDate}>{availabilityLabel(status?.orders)}</small></span>
                <button type="button" className={styles.remove} onClick={(event) => { event.stopPropagation(); void removeCharacter(character); }} disabled={removingId === character.characterId}>{removingId === character.characterId ? "Removing..." : "Remove"}</button>
              </div>;
            })}
          </>
        )}
      </section>
      {selectedCharacter && (() => {
        const selectedStatus = statuses.find((entry) => entry.characterId === selectedCharacter.characterId);
        const hasCorpAccess = selectedCharacter.corpAuthCompleted && selectedCharacter.hasDirectorRole;
        return <div className={styles.modalBackdrop} onClick={() => setSelectedCharacter(null)}>
          <div className={styles.importModal} role="dialog" aria-modal="true" aria-labelledby="character-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}>
              <div className={styles.characterModalHeading}><img className={styles.characterPortrait} src={eveCharacterPortraitUrl(selectedCharacter.characterId)} alt="" /><div><p className={styles.panelKicker}>CHARACTER DETAILS</p><h2 id="character-dialog-title">{selectedCharacter.characterName}</h2></div></div>
              <button type="button" className={styles.importButton} onClick={() => setSelectedCharacter(null)} aria-label="Close character details">Close</button>
            </div>
            <div className={styles.characterModalIdentity}>
              <strong>{selectedCharacter.corporationName ?? (selectedCharacter.corporationId ? `Corporation ${selectedCharacter.corporationId}` : "Corporation unavailable")}</strong>
              <small>{hasCorpAccess ? "Director access" : "Character access only"}</small>
              <small>Director: {roleLabel(selectedCharacter.hasDirectorRole)} · Accountant: {roleLabel(selectedCharacter.hasAccountantRole)} · Trader: {roleLabel(selectedCharacter.hasTraderRole)}</small>
            </div>
            <div className={styles.characterModalStatuses}>
              {(["assets", "jobs", "orders"] as const).map((endpoint) => {
                const endpointStatus = selectedStatus?.[endpoint];
                return <div className={styles.characterModalStatus} key={endpoint}>
                  <small>{endpoint.toUpperCase()}</small>
                  <span><span className={`${styles.statusDot} ${statusClass(endpointStatus, renderedAt)}`} />{statusLabel(endpointStatus, renderedAt)}</span>
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
          ><span><strong>{corporation.corporationName ?? `Corporation ${corporation.corporationId}`}</strong><small>{corporation.pilots.map((pilot) => pilot.characterName).join(" · ")}</small></span><span className={styles.endpointList}><span className={styles.endpointHeaders}><small>ASSETS</small><small>JOBS</small><small>ORDERS</small></span>{(["assets", "jobs", "orders"] as const).map((endpoint) => { const endpointStatus = corporationStatus?.[endpoint]; return <span className={styles.endpointStatus} key={endpoint}><span className={`${styles.statusDot} ${statusClass(endpointStatus, renderedAt)}`} /><small className={styles.endpointState}>{statusLabel(endpointStatus, renderedAt)}</small><small><span className={styles.endpointName}>{endpoint.toUpperCase()}: </span>{availabilityLabel(endpointStatus)}</small></span>; })}</span></div>;
        })}</div>}
      </section>
      {selectedCorporationId !== null && (() => {
        const corporation = corporations.find((entry) => entry.corporationId === selectedCorporationId);
        if (!corporation) return null;
        const corporationStatus = statuses.flatMap((status) => status.corporations ?? []).find((status) => status.corporationId === selectedCorporationId);
        return <div className={styles.modalBackdrop} onClick={() => setSelectedCorporationId(null)}>
          <div className={styles.importModal} role="dialog" aria-modal="true" aria-labelledby="corporation-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}>
              <div className={styles.characterModalHeading}><img className={styles.characterPortrait} src={eveCorporationLogoUrl(corporation.corporationId)} alt="" /><div><p className={styles.panelKicker}>CORPORATION DETAILS</p><h2 id="corporation-dialog-title">{corporation.corporationName ?? `Corporation ${corporation.corporationId}`}</h2></div></div>
              <button type="button" className={styles.importButton} onClick={() => setSelectedCorporationId(null)} aria-label="Close corporation details">Close</button>
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
                  <span><span className={`${styles.statusDot} ${statusClass(endpointStatus, renderedAt)}`} />{statusLabel(endpointStatus, renderedAt)}</span>
                  <small>{availabilityLabel(endpointStatus)}</small>
                  {endpointStatus?.lastModified && <small>Modified {formatDate(endpointStatus.lastModified)}</small>}
                  {endpointStatus?.error && <small>{endpointStatus.error}</small>}
                </div>;
              })}
            </div>
            <div className={styles.characterModalRoles}>
              <p className={styles.panelKicker}>CONNECTED PILOTS AND ROLES</p>
              {corporation.pilots.map((pilot) => <div key={pilot.characterId}><strong>{pilot.characterName}</strong><br />{pilot.corporationRoles.length > 0 ? pilot.corporationRoles.join(", ") : "No corporation roles reported"}</div>)}
            </div>
          </div>
        </div>;
      })()}
    </AppShell>
  );
}
