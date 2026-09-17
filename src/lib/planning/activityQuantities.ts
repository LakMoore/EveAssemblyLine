export type ActivityQuantityJob = {
  countNeeded: number;
  runsAvailable: number;
};

/** Returns the activity quantity currently selected by the planner's Show control. */
export function getDisplayedActivityQuantity(job: ActivityQuantityJob, showTotal: boolean): number {
  return showTotal ? job.countNeeded : job.runsAvailable;
}
