import InfoPage from "@/components/InfoPage";

export const metadata = {
  title: "Terms | Eve AssemblyLine",
  description: "Terms for using Eve AssemblyLine.",
};

export default function TermsPage() {
  return (
    <InfoPage
      eyebrow="TERMS OF USE"
      title="Use the tools with care."
      intro="By using Eve AssemblyLine, you agree to use it lawfully, protect your credentials, and treat its calculations as operational assistance rather than a guarantee."
      sections={[
        {
          eyebrow: "SERVICE",
          title: "What AssemblyLine provides",
          content: (
            <p>
              AssemblyLine provides planning, evaluation, and reference tools for EVE Online. The
              application may change, pause, or remove features, and its output depends on the
              static data, ESI responses, settings, and inputs available at the time of calculation.
            </p>
          ),
        },
        {
          eyebrow: "YOUR RESPONSIBILITY",
          title: "Check before you act",
          content: (
            <ul>
              <li>
                Keep your EVE account credentials and authorization decisions under your control.
              </li>
              <li>
                Review locations, quantities, permissions, prices, and job state before acting
                in-game.
              </li>
              <li>Do not submit data you do not have permission to access or share.</li>
              <li>
                Do not abuse ESI, bypass access controls, or use the service to harm another player.
              </li>
            </ul>
          ),
        },
        {
          eyebrow: "LIMITS",
          title: "Third-party data can change",
          content: (
            <p>
              EVE Online, CCP Games, ESI, market data, and external services are outside
              AssemblyLine&apos;s control. The service is provided without a promise that every
              result is complete, current, or fit for a particular operation. You remain responsible
              for verifying decisions made from its output.
            </p>
          ),
        },
      ]}
    />
  );
}
