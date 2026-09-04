import InfoPage from "@/components/InfoPage";

export const metadata = {
  title: "Cookies | Eve AssemblyLine",
  description: "How Eve AssemblyLine uses cookies and browser storage.",
};

export default function CookiesPage() {
  return (
    <InfoPage
      eyebrow="COOKIES & STORAGE"
      title="A small amount of state, for a useful workspace."
      intro="AssemblyLine uses a secure session cookie plus browser storage to keep your planning workspace useful between visits. It does not use advertising or cross-site tracking cookies."
      sections={[
        {
          eyebrow: "REQUIRED",
          title: "Session cookie",
          content: (
            <p>
              A secure, HttpOnly, same-site session cookie keeps the application connected to your
              server-side workspace. It does not contain an EVE access token or refresh token, and
              it cannot be read by client-side JavaScript.
            </p>
          ),
        },
        {
          eyebrow: "PLANNING WORKSPACE",
          title: "IndexedDB stores more than preferences",
          content: (
            <>
              <p>
                AssemblyLine stores a larger working set in the browser&apos;s IndexedDB database.
                This can include your current build list, saved planner buckets, production
                locations, build and buy exclusions, and compression calculator settings.
              </p>
              <p>
                It can also contain locally cached structures, stock records grouped by location,
                market-order stock, timestamps for the latest stock snapshot, and cached responses
                used to make refreshed assets, jobs, ships, facilities, and other ESI-backed views
                load quickly. Cached ESI data may include personal or corporation asset and job
                information that your connected characters are allowed to retrieve.
              </p>
              <p>
                These browser records are used to restore the workspace and reduce repeated network
                requests. They do not contain EVE access tokens or refresh tokens. IndexedDB data
                remains in the browser until the application replaces or removes it, or you clear
                site data.
              </p>
            </>
          ),
        },
        {
          eyebrow: "PREFERENCES",
          title: "Local browser settings",
          content: (
            <p>
              Local storage may contain your selected theme, SDE language, sidebar state, saved
              locations, known structures, planner settings, and other small interface or planning
              preferences. These values stay on the device and are used to restore the interface on
              your next visit.
            </p>
          ),
        },
        {
          eyebrow: "CLEARING DATA",
          title: "You can remove browser state",
          content: (
            <>
              <p>
                Clearing the site&apos;s cookies, local storage, and IndexedDB data removes the
                locally saved planning workspace, cached ESI responses, and interface preferences.
                It also signs you out of the current browser session. Some server-side account,
                authorization, and cached application records are separate from this browser data;
                contact the maintainers if you need those records removed as well.
              </p>
              <p>
                AssemblyLine does not use third-party advertising cookies, cross-site profiling, or
                analytics scripts to follow you around the web.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
