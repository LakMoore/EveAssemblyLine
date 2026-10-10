"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  loadClientCharacterState,
  loadClientJobs,
  loadClientSession,
  loadClientSystemNames,
  type ClientCharacter,
  type ClientCharacterStatus,
  type ClientRefreshEventDetail,
  type ClientJobsResponse,
} from "@/lib/client/requestCache";
import { useAppLanguage } from "@/app/AppShell";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import { isWormholeSystemId } from "@/lib/planning/simulator/clientScheduler";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import styles from "../page.module.css";
import { Atom, Factory, FlaskConical } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { getSlotUsageTotals, type IndustrySlotCategory } from "@/lib/client/slotUsage";
import {
  getIndustryJobMinutesUntil,
  getNextIndustryActivityJobEndTime,
  nextIndustryJobDetail,
} from "@/lib/client/industryJobs";

const slotOrder: IndustrySlotCategory[] = ["Manufacturing", "Science", "Reactions"];
const scienceJobActivities = new Set([
  "Time research",
  "Material research",
  "Copying",
  "Invention",
]);

type CharacterLocationGroup = {
  key: string;
  name: string;
  order: number;
  characters: ClientCharacter[];
};

function isScienceJob(activity: string) {
  return scienceJobActivities.has(activity);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown end time" : date.toLocaleString();
}

function formatRemaining(value: string) {
  const milliseconds = new Date(value).valueOf() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Completing now";
  const minutes = Math.ceil(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m remaining` : `${minutes}m remaining`;
}

type ClientJob = NonNullable<ClientJobsResponse["jobs"]>[number];

function JobRow({ job, characterName }: { job: ClientJob; characterName: string }) {
  return (
    <article className={styles.jobRow} key={`${job.ownerType}-${job.jobId}`}>
      <div>
        <TypeIdentity
          name={job.productTypeName ?? job.blueprintTypeName ?? "Unknown product"}
          typeName={job.activity}
          typeId={job.productTypeId ?? job.blueprintTypeId}
          imageSize={38}
          className={styles.jobTypeIdentity}
          variation={isScienceJob(job.activity) ? (job.usesBpo ? "bp" : "bpc") : "icon"}
        />
        <small>
          {job.activity} · {characterName}
          {job.ownerType === "corporation" ? " · CORPORATION" : ""}
        </small>
        {job.usesBpo && <Badge className={styles.jobBpoFlag}>From BPO</Badge>}
        <small>{job.outputLocationName}</small>
      </div>
      <span>
        <b>{job.runs.toLocaleString()}</b>
        <small>runs</small>
      </span>
      <span>
        <b>
          {job.outputQuantity.toLocaleString()}
          {job.activity === "Copying" ? " BPCs" : ""}
        </b>
        <small>
          {job.activity === "Copying" && job.outputRunsPerCopy !== undefined
            ? `${job.outputRunsPerCopy.toLocaleString()} runs each`
            : "output"}
        </small>
      </span>
      <span>
        <b>{formatRemaining(job.endDate)}</b>
        <small>{formatDate(job.endDate)}</small>
      </span>
    </article>
  );
}

export default function JobsPage() {
  const { language } = useAppLanguage();
  const [data, setData] = useState<ClientJobsResponse | null>(null);
  const [characters, setCharacters] = useState<ClientCharacter[]>([]);
  const [characterStatuses, setCharacterStatuses] = useState<ClientCharacterStatus[]>([]);
  const [systemNamesById, setSystemNamesById] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (refresh?: ClientRefreshEventDetail) => {
      void Promise
        .all([
          refresh ? Promise.resolve(undefined) : loadClientSession(),
          refresh?.jobs ? Promise.resolve(refresh.jobs) : loadClientJobs(),
          refresh?.state ? Promise.resolve(refresh.state) : loadClientCharacterState(),
        ])
        .then(([session, response, state]) => {
          if (cancelled) return;
          if (session) setCharacters(session.characters ?? []);
          setData(response);
          setCharacterStatuses(state.characters ?? []);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };
    const handleRefresh = (event: Event) => {
      load((event as CustomEvent<ClientRefreshEventDetail>).detail);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    load();
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, []);

  const characterSystemIds = useMemo(
    () => [
      ...new Set(
        characterStatuses.flatMap((character) => {
          const systemId = character.location?.systemId;
          return typeof systemId === "number" && systemId > 0 ? [systemId] : [];
        }),
      ),
    ],
    [characterStatuses],
  );

  useEffect(() => {
    let cancelled = false;
    void loadClientSystemNames(characterSystemIds, language).then((names) => {
      if (!cancelled) setSystemNamesById(names);
    });
    return () => {
      cancelled = true;
    };
  }, [characterSystemIds, language]);

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        setData((current) => current && { ...current });
      },
      60_000,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const jobs = useMemo(() => data?.jobs ?? [], [data?.jobs]);
  const characterNames = useMemo(
    () => new Map(characters.map((character) => [character.characterId, character.characterName])),
    [characters],
  );
  const slotUsage = useMemo(() => data?.slotUsage ?? {}, [data?.slotUsage]);
  const collectionJobCount = useMemo(() => {
    const characterIds = new Set(characters.map((character) => character.characterId));
    return jobs.filter((job) => characterIds.has(job.characterId)).length;
  }, [characters, jobs]);
  const jobGroups = useMemo(() => {
    const allJobs = data?.jobs ?? [];
    const jobsByInstaller = new Map<number, ClientJob[]>();
    for (const job of allJobs) {
      const installerJobs = jobsByInstaller.get(job.characterId) ?? [];
      installerJobs.push(job);
      jobsByInstaller.set(job.characterId, installerJobs);
    }

    const collectionCharacterIds = new Set(characters.map((character) => character.characterId));
    const collectionGroups = characters.flatMap((character) => {
      const installerJobs = jobsByInstaller.get(character.characterId) ?? [];
      return installerJobs.length > 0
        ? [
            {
              key: `character-${character.characterId}`,
              name: character.characterName,
              jobs: installerJobs,
            },
          ]
        : [];
    });
    const otherJobs = allJobs.filter((job) => !collectionCharacterIds.has(job.characterId));
    if (otherJobs.length === 0) return collectionGroups;
    return [
      ...collectionGroups,
      { key: "other-installers", name: "Other Installers", jobs: otherJobs },
    ];
  }, [characters, data]);
  const slotTypes = useMemo(() => {
    const types = new Set<string>(slotOrder);
    for (const usage of Object.values(slotUsage)) {
      for (const type of Object.keys(usage.slots)) types.add(type);
    }
    return [...types];
  }, [slotUsage]);
  const slotCharacterIds = characters
    .filter((character) => !character.onDeployment)
    .map((character) => character.characterId);
  const availableSlotTotals = slotOrder.map((type) => ({
    type,
    ...getSlotUsageTotals(slotUsage, type, slotCharacterIds),
  }));
  const characterLocationGroups = useMemo(() => {
    const statusesByCharacterId = new Map(
      characterStatuses.map((character) => [character.characterId, character]),
    );
    const groups = new Map<string, CharacterLocationGroup>();
    for (const character of characters) {
      const systemId = statusesByCharacterId.get(character.characterId)?.location?.systemId;
      const hasSystemId = typeof systemId === "number" && systemId > 0;
      const isWormhole = hasSystemId && isWormholeSystemId(systemId);
      const key = !hasSystemId ? "unknown" : isWormhole ? `wormhole:${systemId}` : "k-space";
      const name = !hasSystemId
        ? "Location unavailable"
        : isWormhole
          ? (systemNamesById.get(systemId) ?? `Wormhole ${systemId}`)
          : "K-Space";
      const order = !hasSystemId ? 2 : isWormhole ? 1 : 0;
      const group = groups.get(key) ?? { key, name, order, characters: [] };
      group.characters.push(character);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        characters: group.characters.toSorted((left, right) =>
          left.characterName.localeCompare(right.characterName),
        ),
      }))
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  }, [characterStatuses, characters, systemNamesById]);

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">INDUSTRY CONTROL</p>
          <h1>Jobs</h1>
          <p className={styles.subtitle}>
            Monitor active manufacturing, science, and reaction jobs across connected pilots.
          </p>
        </div>
        <div className={styles.shipsStats}>
          <div className={styles.jobsAvailableSlots}>
            <div className={styles.jobsAvailableSlotValues}>
              {availableSlotTotals.map(({ type, availableSlots, inUseSlots, totalSlots }) => {
                const nextManufacturingJobMinutes =
                  type === "Manufacturing"
                    ? getIndustryJobMinutesUntil(
                        getNextIndustryActivityJobEndTime(
                          "manufacturing",
                          data,
                          undefined,
                          new Set(slotCharacterIds),
                        ),
                      )
                    : undefined;
                const slotLabel = `${type}: ${inUseSlots} / ${totalSlots} in use${nextIndustryJobDetail(nextManufacturingJobMinutes)}`;
                return (
                  <span
                    key={type}
                    className={`${styles.jobsAvailableSlot} ${styles.availableSourceIcon}`}
                    title={slotLabel}
                    data-tooltip={slotLabel}
                    aria-label={slotLabel}
                    role="img"
                    tabIndex={0}
                  >
                    <strong>{availableSlots}</strong>
                    {type === "Manufacturing" ? (
                      <Factory aria-hidden="true" />
                    ) : type === "Reactions" ? (
                      <Atom aria-hidden="true" />
                    ) : (
                      <FlaskConical aria-hidden="true" />
                    )}
                  </span>
                );
              })}
            </div>
            <small>SLOTS AVAILABLE</small>
          </div>
          <div className={styles.jobsActiveMetric}>
            <strong>{collectionJobCount}</strong>
            <span>active jobs</span>
          </div>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" className={styles.shipsEmpty}>
          <AlertDescription>Could not load industry jobs.</AlertDescription>
        </Alert>
      )}
      {!error && data && jobs.length === 0 && (
        <Empty className={styles.shipsEmpty}>
          <EmptyDescription>No active industry jobs in the current ESI cache.</EmptyDescription>
        </Empty>
      )}
      <section className={styles.jobsSection}>
        <div className={styles.shipSystemHeader}>
          <div>
            <p className={styles.panelKicker}>SLOT USAGE</p>
            <h2>Connected characters</h2>
          </div>
        </div>
        <div className="grid gap-5">
          {characterLocationGroups.map((group) => {
            const eligibleCharacterIds = group.characters
              .filter((character) => !character.onDeployment)
              .map((character) => character.characterId);
            return (
              <section className="grid gap-3" key={group.key}>
                <div className="flex flex-col items-start justify-between gap-4 border-b border-border pb-2.5 md:flex-row md:items-center">
                  <div>
                    <p className={styles.panelKicker}>LOCATION</p>
                    <h3 className="text-[15px] font-bold text-foreground">{group.name}</h3>
                  </div>
                  <div className="flex flex-wrap justify-start gap-x-4 gap-y-2 md:justify-end">
                    {slotOrder.map((type) => {
                      const totals = getSlotUsageTotals(slotUsage, type, eligibleCharacterIds);
                      return (
                        <span
                          className="grid grid-cols-[26px_auto_auto] items-center gap-2 font-mono text-[11px] text-muted-foreground"
                          key={type}
                          aria-label={`${type}: ${totals.availableSlots} available, ${totals.inUseSlots} in use of ${totals.totalSlots}`}
                        >
                          {type === "Manufacturing" ? (
                            <Factory className="size-[26px]" aria-hidden="true" />
                          ) : type === "Reactions" ? (
                            <Atom className="size-[26px]" aria-hidden="true" />
                          ) : (
                            <FlaskConical className="size-[26px]" aria-hidden="true" />
                          )}
                          <strong className="text-[28px] font-bold text-(--theme-info)">
                            {totals.availableSlots}
                          </strong>
                          <small className="grid gap-0.5 text-[9px] text-foreground uppercase">
                            {type}
                            <span className="text-muted-foreground normal-case">
                              {totals.inUseSlots} / {totals.totalSlots} in use
                            </span>
                          </small>
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className={styles.jobsCharacters}>
                  {group.characters.map((character) => {
                    const usage = slotUsage[String(character.characterId)] ?? {
                      slots: {},
                      availableSlots: {},
                    };
                    return (
                      <div className={styles.jobsCharacter} key={character.characterId}>
                        <div className={styles.jobsCharacterIdentity}>
                          <Image
                            src={eveCharacterPortraitUrl(character.characterId, 64)}
                            alt=""
                            width={32}
                            height={32}
                          />
                          <strong>{character.characterName}</strong>
                        </div>
                        <div className={styles.jobsSlotGrid}>
                          {slotTypes.map((slotType) => (
                            <div key={slotType}>
                              <small>
                                {slotType === "Manufacturing" ? (
                                  <Factory aria-hidden="true" />
                                ) : slotType === "Reactions" ? (
                                  <Atom aria-hidden="true" />
                                ) : slotType === "Science" ? (
                                  <FlaskConical aria-hidden="true" />
                                ) : null}
                                {slotType}
                              </small>
                              <b>
                                {usage.slots[slotType] ?? 0} / {usage.availableSlots[slotType] ?? 0}
                              </b>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </section>
      <section className={styles.jobsSection}>
        <div className={styles.shipSystemHeader}>
          <div>
            <p className={styles.panelKicker}>ACTIVE QUEUE</p>
            <h2>Running industry jobs</h2>
          </div>
        </div>
        <div>
          {jobGroups.map((group) => (
            <div className={styles.jobsInstallerGroup} key={group.key}>
              <div className={styles.jobsInstallerHeader}>
                <p className={styles.panelKicker}>INSTALLER</p>
                <h3>{group.name}</h3>
              </div>
              <div className={styles.jobsList}>
                {group.jobs.map((job) => (
                  <JobRow
                    job={job}
                    characterName={
                      characterNames.get(job.characterId) ?? `Character ${job.characterId}`
                    }
                    key={`${job.ownerType}-${job.jobId}`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
