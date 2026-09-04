import Link from "next/link";
import InfoPage from "@/components/InfoPage";

export const metadata = {
  title: "Guides | Eve AssemblyLine",
  description: "Practical guides for planning EVE Online industry with AssemblyLine.",
};

export default function GuidesPage() {
  return (
    <InfoPage
      eyebrow="FIELD GUIDES"
      title="Plan the work, then move it."
      intro="AssemblyLine is built for large industry jobs where materials, locations, characters, and job queues all matter at once. These short guides explain the intended workflow."
      sections={[
        {
          eyebrow: "START HERE",
          title: "Build a production plan",
          content: (
            <>
              <p>
                Open the <Link href="/planner">Production planner</Link>, add the items and
                quantities you want to produce, then choose the locations and settings that describe
                your operation. The result separates materials to buy, prints to source, jobs to
                install, and work that needs to move.
              </p>
              <p>
                Plans can be created without authentication. Connect a character when you want the
                planner to use up-to-date personal or corporation state.
              </p>
            </>
          ),
        },
        {
          eyebrow: "OPERATIONS",
          title: "Keep the inputs honest",
          content: (
            <ul>
              <li>
                Refresh ESI state before making decisions from assets, jobs, or market orders.
              </li>
              <li>
                Configure structures and corporation hangar sources before relying on stock totals.
              </li>
              <li>Use the Assets and Jobs views to check the data that feeds a plan.</li>
              <li>
                Keep locations explicit so hauling and staged production remain understandable.
              </li>
            </ul>
          ),
        },
        {
          eyebrow: "UTILITY DECK",
          title: "Use the smaller tools",
          content: (
            <ul>
              <li>
                <Link href="/compress">Compress</Link> shows you shows you which ores to buy for
                reprocessing at your build location.
              </li>
              <li>
                <Link href="/appraise">Appraise</Link> turns a pasted item list into ISK and volume
                totals.
              </li>
              <li>
                <Link href="/signals">Signals</Link> helps you decide what to sell today.
              </li>
              <li>
                <Link href="/imagechecker">Image checker</Link> helps diagnose EVE artwork
                identifiers.
              </li>
            </ul>
          ),
        },
      ]}
    />
  );
}
