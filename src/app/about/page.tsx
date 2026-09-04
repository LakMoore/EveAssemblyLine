import InfoPage from "@/components/InfoPage";

export const metadata = {
  title: "About | Eve AssemblyLine",
  description: "Learn what Eve AssemblyLine is built to do.",
};

export default function AboutPage() {
  return (
    <InfoPage
      eyebrow="ABOUT ASSEMBLYLINE"
      title="Industry control for the work between the clicks."
      intro="Eve AssemblyLine is an independent planning workspace for EVE Online pilots and corporations running serious production across New Eden."
      sections={[
        {
          eyebrow: "THE IDEA",
          title: "Make the next decision visible",
          content: (
            <>
              <p>
                Large builds rarely fail because one recipe is difficult. They fail because stock is
                split between locations, jobs are already in flight, and the next dependency is easy
                to overlook. AssemblyLine turns those details into a set of practical lists you can
                act on.
              </p>
              <p>
                The application focuses on materials, prints, invention, reactions, manufacturing,
                and hauling rather than pretending that a single ISK-per-hour number describes an
                industrial operation.
              </p>
            </>
          ),
        },
        {
          eyebrow: "DATA MODEL",
          title: "Local planning, optional live state",
          content: (
            <>
              <p>
                You can use the planning and evaluation tools with local static data. Connecting EVE
                characters adds server-side ESI refreshes for the personal and corporation state
                that your roles permit.
              </p>
              <p>
                AssemblyLine uses the official EVE static data as its planning reference and keeps
                authenticated ESI access on the server. It is not affiliated with or endorsed by CCP
                Games.
              </p>
            </>
          ),
        },
        {
          eyebrow: "OPEN PROJECT",
          title: "Built in public",
          content: (
            <p>
              Product decisions, bug reports, and implementation work live in the project community.
              Visit <a href="https://github.com/LakMoore/EveAssemblyLine">GitHub</a> for the source
              and issue tracker, or join the <a href="https://discord.gg/VdGZWzXahh">Discord</a>
              for discussion.
            </p>
          ),
        },
      ]}
    />
  );
}
