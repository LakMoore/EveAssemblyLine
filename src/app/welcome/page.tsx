import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import styles from "../page.module.css";

export default function WelcomePage() {
  return (
    <div className={styles.welcomePage}>
      <div className={styles.pageIntro}>
        <div className={styles.welcomeIntroCopy}>
          <span className="eyebrow">EVE INDUSTRY CONTROL</span>
          <h1>Welcome to Eve AssemblyLine</h1>
          <p>
            Plan production, inspect your assets, and keep every industrial decision in one place.
          </p>
        </div>
        <Link className={cn(buttonVariants({ variant: "link" }), styles.addButton)} href="/planner">
          Open production planner
        </Link>
      </div>
      <div className={styles.welcomeGrid}>
        <section className={styles.welcomePanel}>
          <span className="eyebrow">TOOLS</span>
          <h2>Build and evaluate</h2>
          <p>
            Use the planner for manufacturing plans, Compress for reprocessing decisions, and
            Appraise to turn a pasted item list into priced ISK and volume totals.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className="eyebrow">INFORMATION</span>
          <h2>See the operation</h2>
          <p>
            Assets, Structures, and Jobs show what you have, where it lives, and what is already
            moving through your facilities.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className="eyebrow">CONFIGURATION</span>
          <h2>Shape your workspace</h2>
          <p>
            Connect Characters when you need live ESI-backed assets and jobs, then configure the
            locations and settings used by your plans.
          </p>
        </section>
        <section className={styles.welcomePanel}>
          <span className="eyebrow">UTILITY</span>
          <h2>Keep assets visible</h2>
          <p>
            Image checker is a small diagnostic tool for verifying the artwork and identifiers used
            throughout the application.
          </p>
        </section>
      </div>
      <section className={styles.aboutPanel}>
        <div className={styles.sectionHeading}>
          <span className="eyebrow">WHY ASSEMBLYLINE</span>
          <h2>Planning for the work between the clicks</h2>
        </div>
        <div className={styles.aboutCopy}>
          <p>
            Eve AssemblyLine is an opinionated industry planning tool for EVE Online, with a set of
            practical utilities around it. It exists to support large build jobs across New Eden:
            the kind of work where materials are distributed across locations, jobs are staged over
            time, and the final result depends on keeping many small decisions aligned.
          </p>
          <p>
            That is also why this tool does not include ISK/hour or profitability calculations.
            Those numbers look precise, but they are usually red herrings. ISK/hour only works if
            you keep every build slot running at 100% of the time. Profit only works if you can buy
            every part, build every stage, and assemble the final pieces instantaneously. Neither
            reflects how a serious operation actually moves through New Eden.
          </p>
          <p>
            AssemblyLine focuses on the useful questions instead: what is needed, what is already
            available, where it is, which jobs must happen first, and what still has to move.
          </p>
        </div>
      </section>
      <div className={styles.roadmapGrid}>
        <section className={styles.roadmapPanel}>
          <div className={styles.sectionHeading}>
            <span className="eyebrow">OPEN WORK</span>
            <h2>Bugs remaining to be fixed</h2>
          </div>
          <ul className={styles.roadmapList}>
            <li>Consider manufacturing ME bonus per item category as it is in-game.</li>
            <li>Remove unnecessary compressed items from the hauling section of the build plan.</li>
          </ul>
        </section>
        <section className={styles.roadmapPanel}>
          <div className={styles.sectionHeading}>
            <span className="eyebrow">NEXT ON THE BOARD</span>
            <h2>Future features</h2>
          </div>
          <ul className={styles.roadmapList}>
            <li>Ship fittings added to build plans and compared wholesale against assets.</li>
            <li>More precise asset exclusion per location.</li>
            <li>Multiple build lists, one for each asset location.</li>
            <li>
              Share structure information and settings with anyone on that structure&apos;s ACL.
            </li>
            <li>Corporation assets with strict access based on in-game roles.</li>
            <li>Four faction themes.</li>
            <li>Singularity SDE version.</li>
          </ul>
        </section>
        <section className={styles.roadmapPanel}>
          <div className={styles.sectionHeading}>
            <span className="eyebrow">NORTH STAR</span>
            <h2>Goals</h2>
          </div>
          <ul className={styles.roadmapList}>
            <li>Replace all UI components with shadcn components.</li>
            <li>
              Make the character-agnostic <code>/plan</code> tool create build plans in under three
              seconds, without authenticated calls to ESI.
            </li>
            <li>Keep the SDE current through automatic updates.</li>
          </ul>
        </section>
      </div>
      <p className={styles.welcomeNote}>
        Character authentication is optional. Without it, you can still work with local planner
        data; connecting a character enables authenticated ESI state and corporation access
        according to that character&apos;s roles.
      </p>
    </div>
  );
}
