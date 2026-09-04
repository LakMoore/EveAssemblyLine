import InfoPage from "@/components/InfoPage";

export const metadata = {
  title: "Contact | Eve AssemblyLine",
  description: "Find support and feedback channels for Eve AssemblyLine.",
};

export default function ContactPage() {
  return (
    <InfoPage
      eyebrow="CONTACT"
      title="Bring the awkward edge cases."
      intro="The most useful reports include the operation you were trying to plan, the data you expected, and the smallest example that shows what went wrong."
      sections={[
        {
          eyebrow: "BUGS & FEATURES",
          title: "Open an issue on GitHub",
          content: (
            <p>
              Use the{" "}
              <a href="https://github.com/LakMoore/EveAssemblyLine/issues">GitHub issue tracker</a>{" "}
              for reproducible bugs, missing EVE data, and feature requests. Please remove character
              names, corporation details, tokens, and private asset information before posting
              screenshots or payloads.
            </p>
          ),
        },
        {
          eyebrow: "DISCUSSION",
          title: "Talk with other pilots",
          content: (
            <p>
              Join the <a href="https://discord.gg/VdGZWzXahh">Eve Apps by Lak Moore Discord</a> for
              workflow questions and project discussion. Support is community-led, so include the
              app version, route, and any visible error text when asking for help.
            </p>
          ),
        },
        {
          eyebrow: "SECURITY",
          title: "Report a private vulnerability",
          content: (
            <p>
              Do not publish credentials, EVE authorization codes, refresh tokens, or exploitable
              details in a public issue. Contact the project maintainers privately through the
              GitHub repository so the report can be triaged without exposing anyone&apos;s account.
            </p>
          ),
        },
      ]}
    />
  );
}
