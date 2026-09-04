import InfoPage from "@/components/InfoPage";
import Link from "next/link";
export const metadata = {
  title: "Privacy | Eve AssemblyLine",
  description: "How Eve AssemblyLine handles account, ESI, and planning data.",
};

export default function PrivacyPage() {
  return (
    <InfoPage
      eyebrow="PRIVACY"
      title="Your industrial data stays purposeful."
      intro="AssemblyLine collects the data needed to authenticate characters, refresh requested EVE state, and return the planning workspace you asked for."
      sections={[
        {
          eyebrow: "WHAT WE HANDLE",
          title: "Authentication and application state",
          content: (
            <ul>
              <li>EVE character identity and authorization records to keep data coherent.</li>
              <li>
                Session records used to keep you signed in and associate characters with your
                workspace.
              </li>
              <li>Planning inputs and preferences needed to calculate and display your results.</li>
              <li>
                Cached ESI responses used to make refreshed assets, jobs, and orders available to
                the app.
              </li>
            </ul>
          ),
        },
        {
          eyebrow: "ESI ACCESS",
          title: "Tokens stay server-side",
          content: (
            <>
              <p>
                Access and refresh tokens are stored and used on the server. They are not sent to
                the browser, included in plan requests, or written to logs. ESI requests are made
                only through the application&apos;s refresh flow and remain subject to EVE scope and
                role permissions.
              </p>
              <p>
                A Director authorization for corporation assets can provide broad corporation-wide
                data to the server. These feeds are not a fine-grained sharing system for one
                member, hangar, or item. The Director permits AssemblyLine to download and cache
                corporation asset data whenever needed, including during unattended refreshes.
              </p>
              <p>
                Cached corporation asset data may be served to other members of the corporation, but
                in-game role-based visibility is enforced. If a player cannot see an asset in EVE,
                that player cannot see it in AssemblyLine. If you do not consent to this pattern of
                downloading, caching, and role-filtered serving of corporation data, do not
                authenticate with AssemblyLine.
              </p>
            </>
          ),
        },
        {
          eyebrow: "YOUR CONTROL",
          title: "Revoke or request removal",
          content: (
            <>
              <p>
                You can revoke EVE authorization through EVE Online. Although you will then have to
                request removal of stored application records by contacting the maintainers using
                the channels on the Contact page.
              </p>
              <p>
                If you revoke EVE Authorization using the buttons on the{" "}
                <Link href="/characters">Characters</Link> page your data will be removed
                immediately.
              </p>
              <p>The app does not gather personal information.</p>
              <p>
                The app does not sell character information or use planning data for advertising.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
