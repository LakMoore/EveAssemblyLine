"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "../AppShell";
import styles from "../page.module.css";

type Character = {
  characterId: number;
  characterName: string;
  corporationId?: number;
  corporationName?: string;
  hasDirectorRole: boolean;
  corpAuthCompleted: boolean;
};

type EndpointStatus = {
  status: "fresh" | "cached" | "rate_limited" | "error";
  lastUpdated?: string;
};

type CharacterStatus = {
  characterId: number;
  assets?: EndpointStatus;
  jobs?: EndpointStatus;
  corporations?: Array<{ corporationId: number; assets?: EndpointStatus }>;
};

function formatDate(value?: string) {
  if (!value) return "Not refreshed";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusLabel(status?: EndpointStatus) {
  if (!status) return "No data";
  if (status.status === "fresh") return "Fresh";
  if (status.status === "rate_limited") return "Rate limited";
  if (status.status === "error") return "Error";
  return "Cached";
}

function statusClass(status?: EndpointStatus) {
  if (status?.status === "fresh") return styles.statusFresh;
  if (status?.status === "rate_limited" || status?.status === "error") return styles.statusError;
  return styles.statusCached;
}

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [statuses, setStatuses] = useState<CharacterStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCharacters() {
    const [charactersResponse, corpResponse] = await Promise.all([fetch("/api/characters"), fetch("/api/auth/corp/status")]);
    if (!charactersResponse.ok) {
      setCharacters([]);
      if (charactersResponse.status !== 401) setError("Could not load connected characters.");
      return;
    }
    const loaded = (await charactersResponse.json()) as Character[];
    const corpStatus = corpResponse.ok ? ((await corpResponse.json()) as Character[]) : [];
    const corpById = new Map(corpStatus.map((character) => [character.characterId, character]));
    setCharacters(loaded.map((character) => ({ ...character, ...corpById.get(character.characterId) })));
  }

  async function loadStatuses() {
    const response = await fetch("/api/state/status");
    if (!response.ok) return;
    const data = (await response.json()) as { characters?: CharacterStatus[] };
    setStatuses(data.characters ?? []);
  }

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([loadCharacters(), loadStatuses()]))
      .catch(() => setError("Could not reach the character service."))
      .finally(() => setIsLoading(false));
    const handleRefresh = () => void loadStatuses();
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, []);

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
            <div className={styles.characterTableHeader}><span>PILOT</span><span>ASSETS</span><span>JOBS</span><span /></div>
            {characters.map((character) => {
              const status = statuses.find((entry) => entry.characterId === character.characterId);
              const hasCorpAccess = character.corpAuthCompleted && character.hasDirectorRole;
              return <div className={styles.characterRow} key={character.characterId}>
                <span className={styles.characterIdentity}><strong>{character.characterName}</strong><small>{character.corporationName ?? (character.corporationId ? `Corporation ${character.corporationId}` : "Corporation unavailable")} / {hasCorpAccess ? "Director access" : "Character access only"}</small></span>
                <span className={styles.statusCell} data-label="Assets" title={`Assets: ${statusLabel(status?.assets)}${status?.assets?.lastUpdated ? `, ${formatDate(status.assets.lastUpdated)}` : ""}`}><span className={`${styles.statusDot} ${statusClass(status?.assets)}`} /><small>{statusLabel(status?.assets)}</small><small className={styles.statusDate}>{formatDate(status?.assets?.lastUpdated)}</small></span>
                <span className={styles.statusCell} data-label="Jobs" title={`Jobs: ${statusLabel(status?.jobs)}${status?.jobs?.lastUpdated ? `, ${formatDate(status.jobs.lastUpdated)}` : ""}`}><span className={`${styles.statusDot} ${statusClass(status?.jobs)}`} /><small>{statusLabel(status?.jobs)}</small><small className={styles.statusDate}>{formatDate(status?.jobs?.lastUpdated)}</small></span>
                <button type="button" className={styles.remove} onClick={() => void removeCharacter(character)} disabled={removingId === character.characterId}>{removingId === character.characterId ? "Removing..." : "Remove"}</button>
              </div>;
            })}
          </>
        )}
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><p className={styles.panelKicker}>02 / CORPORATION ACCESS</p><h2>Eligibility</h2></div></div>
        <p className={styles.panelDescription}>Corporation assets are available when at least one connected pilot has a verified Director role and the required corporation scopes.</p>
        {corporations.length === 0 ? <p className={styles.emptyBuildList}>No corporation information is available yet.</p> : <div className={styles.eligibilityList}>{corporations.map((corporation) => <div className={styles.eligibilityRow} key={corporation.corporationId}><span><strong>{corporation.corporationName ?? `Corporation ${corporation.corporationId}`}</strong><small>{corporation.pilots.map((pilot) => pilot.characterName).join(" · ")}</small></span><span className={styles.statusCell}><span className={`${styles.statusDot} ${statusClass(corporation.status)}`} /><small>{corporation.eligible.length > 0 ? "Eligible" : "Needs Director"}</small><small>{corporation.status ? statusLabel(corporation.status) : "Not refreshed"}</small></span></div>)}</div>}
      </section>
    </AppShell>
  );
}
