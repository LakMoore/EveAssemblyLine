"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { loadClientJobs, type ClientJobsResponse } from "@/lib/client/requestCache";
import { eveCharacterPortraitUrl } from "@/lib/eve/imageServer";
import TypeIdentity from "../components/TypeIdentity";
import styles from "../page.module.css";

const slotOrder = ["Manufacturing", "Reactions", "Science"];
const scienceJobActivities = new Set([
  "Time research",
  "Material research",
  "Copying",
  "Invention",
]);

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

export default function JobsPage() {
  const [data, setData] = useState<ClientJobsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (refreshedJobs?: ClientJobsResponse | null) => {
      if (refreshedJobs) {
        setData(refreshedJobs);
        return;
      }
      void loadClientJobs()
        .then((response) => {
          if (!cancelled) setData(response);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };
    const handleRefresh = (event: Event) => {
      const jobs = (event as CustomEvent<{ jobs?: ClientJobsResponse | null }>).detail.jobs;
      load(jobs);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    load();
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setData((current) => current && { ...current }), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const jobs = data?.jobs ?? [];
  const slotTypes = useMemo(() => {
    const types = new Set(slotOrder);
    for (const character of data?.characters ?? []) {
      for (const type of Object.keys(character.slots)) types.add(type);
    }
    return [...types];
  }, [data]);

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <p className={styles.pageKicker}>INDUSTRY CONTROL</p>
          <h1>Jobs</h1>
        </div>
        <div className={styles.shipsStats}>
          <strong>{jobs.length}</strong>
          <span>active jobs</span>
        </div>
      </div>
      {error && <p className={styles.shipsEmpty}>Could not load industry jobs.</p>}
      {!error && data && jobs.length === 0 && (
        <p className={styles.shipsEmpty}>No active industry jobs in the current ESI cache.</p>
      )}
      <section className={styles.jobsSection}>
        <div className={styles.shipSystemHeader}>
          <div>
            <p className={styles.panelKicker}>SLOT USAGE</p>
            <h2>Connected characters</h2>
          </div>
        </div>
        <div className={styles.jobsCharacters}>
          {(data?.characters ?? []).map((character) => (
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
                {slotTypes.map((type) => (
                  <span key={type}>
                    <small>{type}</small>
                    <b>
                      {character.slots[type] ?? 0} / {character.availableSlots[type] ?? 0}
                    </b>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className={styles.jobsSection}>
        <div className={styles.shipSystemHeader}>
          <div>
            <p className={styles.panelKicker}>ACTIVE QUEUE</p>
            <h2>Running industry jobs</h2>
          </div>
        </div>
        <div className={styles.jobsList}>
          {jobs.map((job) => (
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
                  {job.activity} · {job.characterName}
                  {job.ownerType === "corporation" ? " · CORPORATION" : ""}
                </small>
                {job.usesBpo && <span className={styles.jobBpoFlag}>From BPO</span>}
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
          ))}
        </div>
      </section>
    </>
  );
}
