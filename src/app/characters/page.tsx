"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { GitMerge, LogOut, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { languageStorageKey, useAppRefreshStatus } from "../AppShell";
import DialogBody from "@/components/DialogBody";
import EveAuthorizationWarning from "@/components/EveAuthorizationWarning";
import { replaceEsiStock } from "@/lib/planning/stockStore";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { eveCharacterPortraitUrl, eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  groupClientAssetsByLocation,
  invalidateClientCharacterData,
  loadClientCharacters,
  loadClientCorpStatus,
  loadClientStateStatus,
  loadClientAssets,
  loadClientCorporationSettings,
  saveClientCorporationSettings,
  type ClientCharacter,
  type ClientCorporationSettings,
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
  lastModified?: string;
  lastUpdated?: string;
  expires?: string;
  nextRefreshAllowed?: string;
  rateLimitedUntil?: string;
  error?: string;
  reauthorizeRequired?: boolean;
};

type CharacterStatus = ClientCharacterStatus;

function formatDate(value?: string) {
  if (!value) return "Not refreshed";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function renderedStatus(status: EndpointStatus | undefined): EndpointStatus | undefined {
  if (!status || status.status === "error" || status.status === "rate_limited") return status;
  const expiresAt = Date.parse(status.expires ?? status.nextRefreshAllowed ?? "");
  const updatedAt = Date.parse(status.lastUpdated ?? "");
  const now = Date.now();
  const recentlyModified =
    Number.isFinite(updatedAt) && updatedAt <= now && now - updatedAt <= 2 * 60 * 1000;
  if (recentlyModified) {
    return { ...status, status: "fresh" };
  }
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { ...status, status: "stale" };
  return { ...status, status: "cached" };
}

function statusLabel(status: EndpointStatus | undefined, noAccess = false) {
  if (noAccess) return "No Access";
  const currentStatus = renderedStatus(status);
  if (currentStatus?.status === "error") {
    return currentStatus.reauthorizeRequired ? "Reauthorize required" : "Refresh failed";
  }
  if (!currentStatus || !currentStatus.hasBody) return "Refresh required";
  if (
    currentStatus.status !== "rate_limited"
    && !currentStatus.expires
    && !currentStatus.nextRefreshAllowed
  ) return "Refresh required";
  if (currentStatus.status === "fresh") return "Fresh";
  if (currentStatus.status === "stale") return "Stale";
  if (currentStatus.status === "rate_limited") return "Rate limited";
  return "Cached";
}

function statusClass(status: EndpointStatus | undefined) {
  const currentStatus = renderedStatus(status);
  if (!currentStatus || !currentStatus.hasBody) return styles.statusCached;
  if (currentStatus.status === "fresh") return styles.statusFresh;
  if (currentStatus.status === "stale") return styles.statusError;
  if (currentStatus.status === "rate_limited" || currentStatus.status === "error") {
    return styles.statusError;
  }
  return styles.statusCached;
}

function statusIndicator(status: EndpointStatus | undefined, isRefreshing: boolean) {
  if (isRefreshing) return <Spinner className={styles.statusDot} aria-label="Refreshing" />;
  return <span className={`${styles.statusDot} ${statusClass(status)}`} />;
}

function availabilityLabel(status?: EndpointStatus) {
  if (!status) return "Not loaded";
  if (status.status === "error") return "Refresh failed";
  if (status.status === "rate_limited" && status.rateLimitedUntil) {
    return `Available ${formatDate(status.rateLimitedUntil)}`;
  }
  if (!status.expires && !status.nextRefreshAllowed) return "Refresh required";
  const blockedUntil = status.rateLimitedUntil ?? status.nextRefreshAllowed;
  if (blockedUntil && Date.parse(blockedUntil) > Date.now()) {
    return `Available ${formatDate(blockedUntil)}`;
  }
  return "Available now";
}

function compactAvailabilityText(status?: EndpointStatus) {
  if (!status) return "Not loaded";
  if (status.status === "error") return "Refresh failed";
  if (!status.expires && !status.nextRefreshAllowed && !status.rateLimitedUntil) {
    return "Refresh required";
  }
  const availableAt = status.rateLimitedUntil ?? status.nextRefreshAllowed ?? status.expires;
  const availableAtTime = Date.parse(availableAt ?? "");
  if (Number.isFinite(availableAtTime) && availableAtTime > Date.now()) {
    const minutes = Math.max(1, Math.ceil((availableAtTime - Date.now()) / 60_000));
    return `Available in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return "Available now";
}

function compactAvailabilityLabel(status?: EndpointStatus) {
  const label = compactAvailabilityText(status);
  const match = label.match(/^Available in (\d+) (minute|minutes)$/);
  if (!match) return label;
  return (
    <span className="flex flex-col items-center text-center">
      <span>Available in</span>
      <span className="text-sm">{match[1]}</span>
      <span>{match[2]}</span>
    </span>
  );
}

function expiryLabel(status?: EndpointStatus) {
  if (!status) return "Expires unavailable";
  const expiresAt = status.expires ?? status.nextRefreshAllowed;
  return expiresAt ? `Expires ${formatDate(expiresAt)}` : "Expires unavailable";
}

function roleLabel(hasRole: boolean) {
  return hasRole ? "Yes" : "No";
}

function missingScopes(statuses: CharacterStatus[]) {
  return [
    ...new Set(
      statuses
        .flatMap((character) => [
          character.assets?.error,
          character.skills?.error,
          character.location?.error,
          character.ship?.error,
          character.clones?.error,
          character.blueprints?.error,
          character.jobs?.error,
          character.orders?.error,
          ...(character.corporations ?? []).flatMap((corporation) => [
            corporation.assets?.error,
            corporation.blueprints?.error,
            corporation.structures?.error,
            corporation.jobs?.error,
            corporation.orders?.error,
          ]),
        ])
        .flatMap((error) => {
          const match = error?.match(/scope: (esi-[^\s]+)/i);
          return match ? [match[1]] : [];
        }),
    ),
  ];
}

function personalEndpointStatuses(status: CharacterStatus) {
  return [
    status.assets,
    status.skills,
    status.location,
    status.ship,
    status.clones,
    status.blueprints,
    status.jobs,
    status.orders,
  ];
}

async function reloadStockAfterCharacterRemoval() {
  const savedLanguage = window.localStorage.getItem(languageStorageKey);
  const language: SdeLanguage = isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  const assetsData = await loadClientAssets(language, true);
  const assetLocations = groupClientAssetsByLocation(assetsData);
  await replaceEsiStock(
    assetLocations.map((location) => ({
      systemId: location.systemId ?? 0,
      systemName: location.systemName ?? "Unknown system",
      structureId: String(location.locationId),
      structureName: location.name,
      source: "esi" as const,
      items: location.items,
    })),
  );
  window.dispatchEvent(
    new CustomEvent(
      "assembly-line-esi-refreshed",
      {
        detail: { assetLocations, corporationSources: assetsData.corporationSources },
      },
    ),
  );
}

export default function CharactersPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [statuses, setStatuses] = useState<CharacterStatus[]>([]);
  const [, setFreshnessTick] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const isRefreshing = useAppRefreshStatus();
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [characterPendingRemoval, setCharacterPendingRemoval] = useState<Character | null>(null);
  const [updatingDeploymentId, setUpdatingDeploymentId] = useState<number | null>(null);
  const [updatingDirectorOptInId, setUpdatingDirectorOptInId] = useState<number | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedCorporationId, setSelectedCorporationId] = useState<number | null>(null);
  const [corporationSettings, setCorporationSettings] = useState<ClientCorporationSettings[]>([]);
  const [updatingCorporationId, setUpdatingCorporationId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeDetails, setMergeDetails] = useState<MergeDetails | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);

  async function loadCharacters() {
    const [loaded, corpStatus, settings] = await Promise.all([
      loadClientCharacters(),
      loadClientCorpStatus(),
      loadClientCorporationSettings(),
    ]);
    setCorporationSettings(settings);
    const corpById = new Map(corpStatus.map((character) => [character.characterId, character]));
    setCharacters(
      loaded.map((character) => ({
        ...character,
        ...corpById.get(character.characterId),
        onDeployment: Boolean(character.onDeployment),
      })),
    );
  }

  async function loadStatuses(reload = false) {
    const data = await loadClientStateStatus(reload);
    setStatuses(data.characters ?? []);
    setFreshnessTick((tick) => tick + 1);
  }

  useEffect(() => {
    void Promise.resolve()
      .then(() => Promise.all([loadCharacters(), loadStatuses()]))
      .catch(() => setError("Could not reach the character service."))
      .finally(() => setIsLoading(false));
    const freshnessTimer = window.setInterval(() => setFreshnessTick((tick) => tick + 1), 5_000);
    const handleRefreshFinished = () => {
      void loadStatuses(true);
    };
    window.addEventListener("assembly-line-esi-refresh-finished", handleRefreshFinished);
    return () => {
      window.clearInterval(freshnessTimer);
      window.removeEventListener("assembly-line-esi-refresh-finished", handleRefreshFinished);
    };
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("merge")) return;
    void fetch("/api/auth/merge")
      .then(
        (response) =>
          response.json() as Promise<{ mergeRequired?: boolean } & Partial<MergeDetails>>,
      )
      .then((data) => {
        if (
          data.mergeRequired
          && data.incomingCharacter
          && data.currentCharacters
          && data.incomingCharacters
        ) {
          setMergeDetails({
            incomingCharacter: data.incomingCharacter,
            currentCharacters: data.currentCharacters,
            incomingCharacters: data.incomingCharacters,
          });
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
    }
    catch (mergeError) {
      setError(
        mergeError instanceof Error ? mergeError.message : "Could not merge character collections.",
      );
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
    setRemovingId(character.characterId);
    setError(null);
    try {
      const response = await fetch(
        `/api/characters/${character.characterId}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not remove character.");
      }
      setCharacters((current) =>
        current.filter((entry) => entry.characterId !== character.characterId),
      );
      setStatuses((current) =>
        current.filter((entry) => entry.characterId !== character.characterId),
      );
      invalidateClientCharacterData();
      try {
        await reloadStockAfterCharacterRemoval();
      }
      catch {
        setError("Character removed, but stock could not be refreshed.");
      }
    }
    catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove character.");
    }
    finally {
      setRemovingId(null);
    }
  }

  async function logoutAll() {
    setIsLoggingOut(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not log out of this session.");
      window.location.assign("/");
    }
    catch (logoutError) {
      setError(
        logoutError instanceof Error ? logoutError.message : "Could not log out of this session.",
      );
      setIsLoggingOut(false);
    }
  }

  async function confirmCharacterRemoval() {
    if (!characterPendingRemoval) return;
    const character = characterPendingRemoval;
    setCharacterPendingRemoval(null);
    await removeCharacter(character);
  }

  async function updateDeploymentStatus(character: Character, onDeployment: boolean) {
    const previousValue = character.onDeployment;
    setCharacters((current) =>
      current.map((entry) =>
        entry.characterId === character.characterId ? { ...entry, onDeployment } : entry,
      ),
    );
    setUpdatingDeploymentId(character.characterId);
    setError(null);
    try {
      const response = await fetch(
        `/api/characters/${character.characterId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onDeployment }),
        },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not update deployment status.");
      }
      invalidateClientCharacterData();
    }
    catch (deploymentError) {
      setCharacters((current) =>
        current.map((entry) =>
          entry.characterId === character.characterId
            ? { ...entry, onDeployment: previousValue }
            : entry,
        ),
      );
      setError(
        deploymentError instanceof Error
          ? deploymentError.message
          : "Could not update deployment status.",
      );
    }
    finally {
      setUpdatingDeploymentId(null);
    }
  }

  async function updateDirectorCorpRefreshOptIn(character: Character, enabled: boolean) {
    const previousValue = character.allowCorpRefreshOptIn;
    setCharacters((current) =>
      current.map((entry) =>
        entry.characterId === character.characterId
          ? { ...entry, allowCorpRefreshOptIn: enabled }
          : entry,
      ),
    );
    setUpdatingDirectorOptInId(character.characterId);
    setError(null);
    try {
      const response = await fetch(
        `/api/characters/${character.characterId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowCorpRefreshOptIn: enabled }),
        },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not update corporation refresh opt-in.");
      }
      invalidateClientCharacterData();
    }
    catch (optInError) {
      setCharacters((current) =>
        current.map((entry) =>
          entry.characterId === character.characterId
            ? { ...entry, allowCorpRefreshOptIn: previousValue }
            : entry,
        ),
      );
      setError(
        optInError instanceof Error
          ? optInError.message
          : "Could not update corporation refresh opt-in.",
      );
    }
    finally {
      setUpdatingDirectorOptInId(null);
    }
  }

  async function updateCorporationSupport(corporationId: number, supportEnabled: boolean) {
    const previous = corporationSettings.find((entry) => entry.corporationId === corporationId);
    const nextSettings: ClientCorporationSettings = {
      corporationId,
      supportEnabled,
      directHangars: previous?.directHangars ?? [],
      containerItemIds: previous?.containerItemIds ?? [],
    };
    setCorporationSettings((current) => [
      ...current.filter((entry) => entry.corporationId !== corporationId),
      nextSettings,
    ]);
    setCharacters((current) =>
      current.map((character) =>
        character.corporationId === corporationId
          ? { ...character, corporationSupportEnabled: supportEnabled }
          : character,
      ),
    );
    setUpdatingCorporationId(corporationId);
    setError(null);
    try {
      await saveClientCorporationSettings(nextSettings);
      invalidateClientCharacterData();
      window.dispatchEvent(new CustomEvent("assembly-line-corporation-settings-changed"));
    }
    catch (supportError) {
      setCorporationSettings((current) =>
        previous
          ? [...current.filter((entry) => entry.corporationId !== corporationId), previous]
          : current.filter((entry) => entry.corporationId !== corporationId),
      );
      setCharacters((current) =>
        current.map((character) =>
          character.corporationId === corporationId
            ? { ...character, corporationSupportEnabled: previous?.supportEnabled === true }
            : character,
        ),
      );
      setError(
        supportError instanceof Error
          ? supportError.message
          : "Could not update corporation support.",
      );
    }
    finally {
      setUpdatingCorporationId(null);
    }
  }

  const corporations = [
    ...new Set(characters.map((character) => character.corporationId).filter(Boolean)),
  ].map((corporationId) => {
    const pilots = characters.filter((character) => character.corporationId === corporationId);
    const eligible = pilots.filter((character) => character.hasDirectorRole);
    const corpStatuses = pilots
      .flatMap(
        (pilot) =>
          statuses.find((status) => status.characterId === pilot.characterId)?.corporations ?? [],
      )
      .filter((status) => status.corporationId === corporationId);
    return {
      corporationId: corporationId!,
      corporationName: pilots[0]?.corporationName,
      pilots,
      eligible,
      status: corpStatuses[0]?.assets,
    };
  });
  const scopes = missingScopes(statuses);
  const hasAuthorizationErrors = statuses.some((status) =>
    personalEndpointStatuses(status).some((endpoint) => endpoint?.reauthorizeRequired),
  );
  const characterNamesById = new Map(
    characters.map((character) => [character.characterId, character.characterName]),
  );
  const charactersNeedingReauthorization = statuses
    .filter((status) =>
      personalEndpointStatuses(status).some((endpoint) => endpoint?.reauthorizeRequired),
    )
    .map(
      (status) => characterNamesById.get(status.characterId) ?? `Character ${status.characterId}`,
    );

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">CONFIGURATION / ACCESS</p>
          <h1>Characters</h1>
          <p className={styles.subtitle}>
            Manage the pilots available to the planner and verify corporation access.
          </p>
        </div>
        <div className={styles.pageIntroActions}>
          <EveAuthorizationWarning href="/api/auth/eve/start">
            <Button variant="link" className={styles.characterAction} type="button">
              <Plus data-icon="inline-start" aria-hidden="true" />
              <span>Add character</span>
            </Button>
          </EveAuthorizationWarning>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="link" className={styles.characterAction} disabled={isLoggingOut} />
              }
              aria-label="Logout all"
              onClick={() => {
                setIsLogoutDialogOpen(true);
              }}
            >
              <LogOut aria-hidden="true" />
              <span>{isLoggingOut ? "Logging out..." : "Logout all"}</span>
            </TooltipTrigger>
            <TooltipContent>Detach all characters from this session</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" className={styles.importError}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {hasAuthorizationErrors && (
        <Alert variant="destructive" className={styles.importError}>
          <AlertDescription>
            EVE authorization failed for {charactersNeedingReauthorization.join(", ")}. Reauthorize
            each affected character to restore personal assets, jobs, and orders.
          </AlertDescription>
        </Alert>
      )}
      {scopes.length > 0 && (
        <Alert variant="destructive" className={styles.importError}>
          <AlertDescription>
            EVE authorization is missing {scopes.join(", ")}. Reconnect the affected character to
            grant this scope.
          </AlertDescription>
        </Alert>
      )}
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / CONNECTED PILOTS</p>
            <h2>{isLoading ? "Loading characters..." : `${characters.length} connected`}</h2>
          </div>
          <span className={styles.panelDescription}>
            Use Refresh data in the top bar to update all connected pilots.
          </span>
        </div>
        {!isLoading && characters.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <strong>No characters connected</strong>
            <EmptyDescription>
              Connect an EVE character to make assets, jobs, and corporation access available.
            </EmptyDescription>
            <EveAuthorizationWarning href="/api/auth/eve/start">
              <Button variant="link" className={styles.characterAction} type="button">
                <Plus data-icon="inline-start" aria-hidden="true" />
                <span>Connect with EVE SSO</span>
              </Button>
            </EveAuthorizationWarning>
          </Empty>
        ) : (
          <>
            {characters.map((character) => {
              const status = statuses.find((entry) => entry.characterId === character.characterId);
              const hasAuthorizationError = status
                ? personalEndpointStatuses(status).some((endpoint) => endpoint?.reauthorizeRequired)
                : false;
              const hasCorpAccess = character.hasDirectorRole;
              return (
                <div
                  className={`${styles.characterRow} ${hasAuthorizationError ? styles.characterRowWithReauthorize : ""}`}
                  key={character.characterId}
                >
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <button
                      type="button"
                      className={styles.characterRowButton}
                      onClick={() => setSelectedCharacter(character)}
                    >
                      <span className={styles.characterIdentity}>
                        <Image
                          className={styles.characterCardPortrait}
                          src={eveCharacterPortraitUrl(character.characterId)}
                          alt=""
                          width={40}
                          height={40}
                        />
                        <span className={styles.characterIdentityText}>
                          <strong>{character.characterName}</strong>
                          <small>
                            {character.corporationName
                              ?? (character.corporationId
                                ? `Corporation ${character.corporationId}`
                                : "Corporation unavailable")}{" "}
                            / {hasCorpAccess ? "Director access" : "Character access only"}
                          </small>
                          <small>
                            Director: {roleLabel(character.hasDirectorRole)} · Accountant:{" "}
                            {roleLabel(character.hasAccountantRole)} · Trader:{" "}
                            {roleLabel(character.hasTraderRole)}
                          </small>
                        </span>
                      </span>
                    </button>
                    <div className="flex min-w-44 flex-col items-end gap-2">
                      <label className="flex items-center gap-2 text-xs">
                        <span>On Deployment</span>
                        <Switch
                          checked={character.onDeployment}
                          disabled={updatingDeploymentId === character.characterId}
                          onCheckedChange={(checked) => {
                            void updateDeploymentStatus(character, checked);
                          }}
                          aria-label={`On Deployment for ${character.characterName}`}
                        />
                      </label>
                      {character.corpRefreshOptInEnabled
                        && character.hasDirectorRole
                        && character.canManageCorpRefreshOptIn && (
                          <label className="flex items-center gap-2 text-xs">
                            <span>Corp refresh opt-in</span>
                            <Switch
                              checked={character.allowCorpRefreshOptIn}
                              disabled={updatingDirectorOptInId === character.characterId}
                              onCheckedChange={(checked) => {
                                void updateDirectorCorpRefreshOptIn(character, checked);
                              }}
                              aria-label={`Allow ${character.characterName} corporation refresh opt-in`}
                            />
                          </label>
                        )}
                      <span className={styles.characterActions}>
                        {hasAuthorizationError && !isRefreshing && (
                          <EveAuthorizationWarning
                            href={`/api/auth/eve/start?characterId=${character.characterId}`}
                          >
                            <button
                              type="button"
                              className={`actionButton ${styles.characterReauthorize}`}
                              aria-label={`Re-authorise ${character.characterName}`}
                              title="Re-authorise character"
                            >
                              <RotateCcw aria-hidden="true" strokeWidth={1.8} />
                              <span>Re-authorise</span>
                            </button>
                          </EveAuthorizationWarning>
                        )}
                        <button
                          type="button"
                          className={`actionButton ${styles.characterRemove}`}
                          onClick={() => {
                            setCharacterPendingRemoval(character);
                          }}
                          disabled={removingId === character.characterId}
                          aria-label={
                            removingId === character.characterId
                              ? "Removing character"
                              : `Remove ${character.characterName}`
                          }
                          title={
                            removingId === character.characterId
                              ? "Removing character"
                              : "Remove character"
                          }
                        >
                          <Trash2 aria-hidden="true" strokeWidth={1.8} />
                          <span>
                            {removingId === character.characterId ? "Removing..." : "Remove"}
                          </span>
                        </button>
                      </span>
                    </div>
                  </div>
                  <ItemGroup className="grid w-full grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-3">
                    {(
                      [
                        "assets",
                        "skills",
                        "location",
                        "ship",
                        "clones",
                        "blueprints",
                        "jobs",
                        "orders",
                      ] as const
                    ).map((endpoint) => {
                      const endpointStatus = status?.[endpoint];
                      return (
                        <Item
                          aria-label={`View ${endpoint} details for ${character.characterName}`}
                          key={endpoint}
                          className="min-w-0"
                          onClick={() => setSelectedCharacter(character)}
                          render={<button type="button" />}
                          size="sm"
                          title={`${endpoint}: ${compactAvailabilityText(endpointStatus)}${endpointStatus?.error ? `; ${endpointStatus.error}` : ""}${endpointStatus?.lastModified ? `; modified ${formatDate(endpointStatus.lastModified)}` : ""}`}
                          variant="outline"
                        >
                          <ItemContent className="flex flex-1 flex-col items-center gap-1">
                            <ItemTitle className="w-full justify-center text-center">
                              {endpoint.toUpperCase()}
                            </ItemTitle>
                            <ItemDescription className="flex flex-col items-center gap-1 text-center">
                              <span className="flex items-center justify-center gap-1 text-center">
                                {statusIndicator(endpointStatus, isRefreshing)}
                                {statusLabel(endpointStatus)}
                              </span>
                              <span className={`${styles.availabilityWide} text-center`}>
                                {compactAvailabilityLabel(endpointStatus)}
                              </span>
                              <span className={`${styles.availabilityNarrow} text-center`}>
                                {compactAvailabilityLabel(endpointStatus)}
                              </span>
                            </ItemDescription>
                          </ItemContent>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                </div>
              );
            })}
          </>
        )}
      </section>
      {selectedCharacter
        && (() => {
          const selectedStatus = statuses.find(
            (entry) => entry.characterId === selectedCharacter.characterId,
          );
          const hasCorpAccess = selectedCharacter.hasDirectorRole;
          return (
            <Dialog open onOpenChange={(open) => !open && setSelectedCharacter(null)}>
              <DialogContent className={styles.importModal}>
                <DialogBody>
                  <div className={styles.panelHeader}>
                    <div className={styles.characterModalHeading}>
                      <Image
                        className={styles.characterPortrait}
                        src={eveCharacterPortraitUrl(selectedCharacter.characterId)}
                        alt=""
                        width={64}
                        height={64}
                      />
                      <div>
                        <p className={styles.panelKicker}>CHARACTER DETAILS</p>
                        <DialogTitle>{selectedCharacter.characterName}</DialogTitle>
                      </div>
                    </div>
                  </div>
                  <div className={styles.characterModalIdentity}>
                    <strong className={styles.characterModalCorporation}>
                      {selectedCharacter.corporationId && (
                        <Image
                          className={styles.characterCorporationLogo}
                          src={eveCorporationLogoUrl(selectedCharacter.corporationId)}
                          alt=""
                          width={28}
                          height={28}
                        />
                      )}
                      <span>
                        {selectedCharacter.corporationName
                          ?? (selectedCharacter.corporationId
                            ? `Corporation ${selectedCharacter.corporationId}`
                            : "Corporation unavailable")}
                      </span>
                    </strong>
                    <small>{hasCorpAccess ? "Director access" : "Character access only"}</small>
                    <small>
                      Director: {roleLabel(selectedCharacter.hasDirectorRole)} · Accountant:{" "}
                      {roleLabel(selectedCharacter.hasAccountantRole)} · Trader:{" "}
                      {roleLabel(selectedCharacter.hasTraderRole)}
                    </small>
                  </div>
                  <ItemGroup className="mt-5 grid w-full grid-cols-3 gap-2.5 max-[640px]:grid-cols-1">
                    {(
                      [
                        "assets",
                        "skills",
                        "location",
                        "ship",
                        "clones",
                        "blueprints",
                        "jobs",
                        "orders",
                      ] as const
                    ).map((endpoint) => {
                      const endpointStatus = selectedStatus?.[endpoint];
                      return (
                        <Item key={endpoint} className="min-w-0" size="sm" variant="outline">
                          <ItemContent className="flex flex-col items-center gap-1">
                            <ItemTitle className="w-full justify-center text-center">
                              {endpoint.toUpperCase()}
                            </ItemTitle>
                            <ItemDescription className="flex flex-col items-center gap-1 text-center">
                              <span className="flex items-center justify-center gap-1 text-center">
                                {statusIndicator(endpointStatus, isRefreshing)}
                                <span>{statusLabel(endpointStatus)}</span>
                              </span>
                              {endpointStatus?.lastModified && (
                                <span className="text-center">
                                  Modified {formatDate(endpointStatus.lastModified)}
                                </span>
                              )}
                              {endpointStatus?.lastUpdated && (
                                <span className="text-center">
                                  Updated {formatDate(endpointStatus.lastUpdated)}
                                </span>
                              )}
                              <span className="text-center">{expiryLabel(endpointStatus)}</span>
                              {endpointStatus?.error && (
                                <span className="text-center">{endpointStatus.error}</span>
                              )}
                            </ItemDescription>
                          </ItemContent>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                  <div className={styles.characterModalRoles}>
                    <p className={styles.panelKicker}>CORPORATION ROLES</p>
                    <div>
                      {selectedCharacter.corporationRoles.length > 0
                        ? selectedCharacter.corporationRoles.join(", ")
                        : "No corporation roles reported"}
                    </div>
                    <div>
                      <strong>Base:</strong>{" "}
                      {selectedCharacter.rolesAtBase.length > 0
                        ? selectedCharacter.rolesAtBase.join(", ")
                        : "No roles reported"}
                    </div>
                    <div>
                      <strong>HQ:</strong>{" "}
                      {selectedCharacter.rolesAtHq.length > 0
                        ? selectedCharacter.rolesAtHq.join(", ")
                        : "No roles reported"}
                    </div>
                    <div>
                      <strong>Other:</strong>{" "}
                      {selectedCharacter.rolesAtOther.length > 0
                        ? selectedCharacter.rolesAtOther.join(", ")
                        : "No roles reported"}
                    </div>
                  </div>
                </DialogBody>
              </DialogContent>
            </Dialog>
          );
        })()}
      {mergeDetails && (
        <Dialog open onOpenChange={(open) => !open && window.location.assign("/characters")}>
          <DialogContent className={`${styles.importModal} ${styles.mergeModal}`}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.panelKicker}>ACCOUNT COLLECTION MERGE</p>
                <DialogTitle>Merge character collections?</DialogTitle>
              </div>
            </div>
            <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
              <p className={styles.mergeLead}>
                The authenticated character belongs to another collection. Merge them to make both
                collections available in every linked session.
              </p>
              <div className={styles.mergeCollections}>
                <div className={styles.mergeCollection}>
                  <p className={styles.panelKicker}>THIS SESSION</p>
                  <div className={styles.mergePortraits}>
                    {mergeDetails.currentCharacters.map((character) => (
                      <div className={styles.mergeCharacter} key={character.characterId}>
                        <Image
                          className={styles.mergePortrait}
                          src={eveCharacterPortraitUrl(character.characterId)}
                          alt=""
                          width={52}
                          height={52}
                        />
                        <span>{character.characterName}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.mergeDivider} aria-hidden="true">
                  +
                </div>
                <div className={styles.mergeCollection}>
                  <p className={styles.panelKicker}>OTHER COLLECTION</p>
                  <div className={styles.mergePortraits}>
                    {mergeDetails.incomingCharacters.map((character) => (
                      <div className={styles.mergeCharacter} key={character.characterId}>
                        <Image
                          className={styles.mergePortrait}
                          src={eveCharacterPortraitUrl(character.characterId)}
                          alt=""
                          width={52}
                          height={52}
                        />
                        <span>{character.characterName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.mergeNote}>
                <strong>{mergeDetails.incomingCharacter.characterName}</strong> will be added to
                this session.
              </div>
            </div>
            <DialogFooter>
              <button
                type="button"
                className={`actionButton ${styles.mergeCancelButton}`}
                onClick={() => window.location.assign("/characters")}
                disabled={isMerging}
              >
                <X aria-hidden="true" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className={`actionButton ${styles.mergeConfirmButton}`}
                onClick={() => void confirmMerge()}
                disabled={isMerging}
              >
                <GitMerge aria-hidden="true" />
                <span>{isMerging ? "Merging..." : "Merge collections"}</span>
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>02 / CORPORATION ACCESS</p>
            <h2>Eligibility</h2>
          </div>
        </div>
        <p className={styles.panelDescription}>
          Turn this on to include the corporation when Refresh data updates its cached assets,
          blueprints, jobs, and orders. Then choose which refreshed hangars and containers the
          planner can use on the Assets page. A connected pilot still needs the required EVE access.
        </p>
        {corporations.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>No corporation information is available yet.</EmptyDescription>
          </Empty>
        ) : (
          <div className={styles.eligibilityList}>
            {corporations.map((corporation) => {
              const corporationStatus = statuses
                .flatMap((status) => status.corporations ?? [])
                .find((status) => status.corporationId === corporation.corporationId);
              return (
                <div
                  className={`${styles.eligibilityRow} flex flex-col items-stretch gap-4`}
                  key={corporation.corporationId}
                >
                  <div className="flex items-start justify-between gap-4">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                      onClick={() => setSelectedCorporationId(corporation.corporationId)}
                    >
                      <span className="flex items-center gap-2">
                        <Image
                          className={styles.eligibilityCorporationLogo}
                          src={eveCorporationLogoUrl(corporation.corporationId)}
                          alt=""
                          width={32}
                          height={32}
                        />
                        <strong>
                          {corporation.corporationName
                            ?? `Corporation ${corporation.corporationId}`}
                        </strong>
                      </span>
                      <small>
                        {corporation.pilots.map((pilot) => pilot.characterName).join(" · ")}
                      </small>
                    </button>
                    <label className="flex shrink-0 items-center gap-2 text-xs">
                      <span>Include in Refresh</span>
                      <Switch
                        checked={
                          corporationSettings.find(
                            (entry) => entry.corporationId === corporation.corporationId,
                          )?.supportEnabled === true
                        }
                        disabled={updatingCorporationId === corporation.corporationId}
                        onCheckedChange={(checked) => {
                          void updateCorporationSupport(corporation.corporationId, checked);
                        }}
                        aria-label={`Include ${corporation.corporationName ?? `corporation ${corporation.corporationId}`} in refresh`}
                      />
                    </label>
                  </div>
                  <ItemGroup className="grid w-full grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-3">
                    {(["assets", "blueprints", "structures", "jobs", "orders"] as const).map(
                      (endpoint) => {
                        const endpointStatus = corporationStatus?.[endpoint];
                        return (
                          <Item
                            aria-label={`View ${endpoint} details for ${corporation.corporationName ?? `Corporation ${corporation.corporationId}`}`}
                            className="min-w-0"
                            key={endpoint}
                            onClick={() => setSelectedCorporationId(corporation.corporationId)}
                            render={<button type="button" />}
                            size="sm"
                            variant="outline"
                          >
                            <ItemContent className="flex flex-1 flex-col items-center gap-1">
                              <ItemTitle className="w-full justify-center text-center">
                                {endpoint.toUpperCase()}
                              </ItemTitle>
                              <ItemDescription className="flex flex-col items-center gap-1 text-center">
                                <span className="flex items-center justify-center gap-1 text-center">
                                  {statusIndicator(endpointStatus, isRefreshing)}
                                  {statusLabel(endpointStatus, corporation.eligible.length === 0)}
                                </span>
                                <span className="flex flex-col items-center text-center">
                                  <span className={`${styles.availabilityWide} text-center`}>
                                    {compactAvailabilityLabel(endpointStatus)}
                                  </span>
                                  <span className={`${styles.availabilityNarrow} text-center`}>
                                    {compactAvailabilityLabel(endpointStatus)}
                                  </span>
                                </span>
                              </ItemDescription>
                            </ItemContent>
                          </Item>
                        );
                      },
                    )}
                  </ItemGroup>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {selectedCorporationId !== null
        && (() => {
          const corporation = corporations.find(
            (entry) => entry.corporationId === selectedCorporationId,
          );
          if (!corporation) return null;
          const corporationStatus = statuses
            .flatMap((status) => status.corporations ?? [])
            .find((status) => status.corporationId === selectedCorporationId);
          return (
            <Dialog open onOpenChange={(open) => !open && setSelectedCorporationId(null)}>
              <DialogContent className={styles.importModal}>
                <div className={styles.panelHeader}>
                  <div className={styles.corporationModalHeading}>
                    <p className={styles.panelKicker}>CORPORATION DETAILS</p>
                    <div className={styles.corporationModalIdentityHeading}>
                      <Image
                        className={styles.characterPortrait}
                        src={eveCorporationLogoUrl(corporation.corporationId)}
                        alt=""
                        width={64}
                        height={64}
                      />
                      <DialogTitle>
                        {corporation.corporationName ?? `Corporation ${corporation.corporationId}`}
                      </DialogTitle>
                    </div>
                  </div>
                </div>
                <div className="no-scrollbar max-h-[70vh] overflow-y-auto overscroll-contain">
                  <div className={styles.characterModalIdentity}>
                    <strong
                      className={
                        corporation.eligible.length === 0
                          ? styles.characterModalAccessRequired
                          : undefined
                      }
                    >
                      {corporation.eligible.length > 0
                        ? "Director access available"
                        : "Director access required"}
                    </strong>
                    <small>
                      {corporation.pilots.length} connected pilot
                      {corporation.pilots.length === 1 ? "" : "s"}
                    </small>
                  </div>
                  <ItemGroup className="mt-5 grid w-full grid-cols-3 gap-2.5 max-[640px]:grid-cols-1">
                    {(["assets", "blueprints", "structures", "jobs", "orders"] as const).map(
                      (endpoint) => {
                        const endpointStatus = corporationStatus?.[endpoint];
                        return (
                          <Item key={endpoint} className="min-w-0" size="sm" variant="outline">
                            <ItemContent className="flex flex-col items-center gap-1">
                              <ItemTitle className="w-full justify-center text-center">
                                {endpoint.toUpperCase()}
                              </ItemTitle>
                              <ItemDescription className="flex flex-col items-center gap-1 text-center">
                                <span className="flex items-center justify-center gap-1 text-center">
                                  {statusIndicator(endpointStatus, isRefreshing)}
                                  <span>
                                    {statusLabel(endpointStatus, corporation.eligible.length === 0)}
                                  </span>
                                </span>
                                <span className="text-center">
                                  {availabilityLabel(endpointStatus)}
                                </span>
                                {endpointStatus?.lastModified && (
                                  <span className="text-center">
                                    Modified {formatDate(endpointStatus.lastModified)}
                                  </span>
                                )}
                                {endpointStatus?.lastUpdated && (
                                  <span className="text-center">
                                    Updated {formatDate(endpointStatus.lastUpdated)}
                                  </span>
                                )}
                                {endpointStatus?.error && (
                                  <span className="text-center">{endpointStatus.error}</span>
                                )}
                              </ItemDescription>
                            </ItemContent>
                          </Item>
                        );
                      },
                    )}
                  </ItemGroup>
                  <div className={styles.characterModalRoles}>
                    <p className={styles.panelKicker}>CONNECTED PILOTS AND ROLES</p>
                    {corporation.pilots.map((pilot) => (
                      <div className={styles.corporationPilot} key={pilot.characterId}>
                        <Image
                          className={styles.corporationPilotPortrait}
                          src={eveCharacterPortraitUrl(pilot.characterId)}
                          alt=""
                          width={32}
                          height={32}
                        />
                        <div>
                          <strong>{pilot.characterName}</strong>
                          <br />
                          {pilot.corporationRoles.length > 0
                            ? pilot.corporationRoles.join(", ")
                            : "No corporation roles reported"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          );
        })()}
      <AlertDialog
        open={characterPendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removingId) setCharacterPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove character?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove {characterPendingRemoval?.characterName} from this session? Their cached data
              will no longer be available here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmCharacterRemoval()}>
              Remove character
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={isLogoutDialogOpen} onOpenChange={setIsLogoutDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out all characters?</AlertDialogTitle>
            <AlertDialogDescription>
              This will detach every character from this session. You will need to sign in again or
              work without ESI support.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoggingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isLoggingOut}
              onClick={() => {
                setIsLogoutDialogOpen(false);
                void logoutAll();
              }}
            >
              {isLoggingOut ? "Logging out..." : "Logout all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
