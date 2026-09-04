import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterTokenRecord, TokenSet } from "@/lib/auth/model";
import {
  fetchCharacterCorporationAuthorization,
  fetchCharacterIndustryJobs,
  fetchCharacterLocation,
  fetchCharacterRoles,
  fetchCharacterShip,
  fetchCorporationStructures,
  fetchEsiEndpoint,
} from "./client";

const token: TokenSet = {
  refreshToken: "refresh-token",
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  scopes: [],
  lastUsedAt: 0,
};

const character: CharacterTokenRecord = {
  characterId: 42,
  characterName: "Test Pilot",
  personalAuth: token,
};

test("maps character role locations from the ESI response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    Response.json({
      roles: ["Factory_Manager"],
      roles_at_base: ["Container_Take_2"],
      roles_at_hq: ["Hangar_Query_6"],
      roles_at_other: ["Hangar_Take_2"],
    });

  const result = await fetchCharacterRoles(42, token);

  assert.deepEqual(
    result,
    {
      roles: ["Factory_Manager"],
      rolesAtBase: ["Container_Take_2"],
      rolesAtHq: ["Hangar_Query_6"],
      rolesAtOther: ["Hangar_Take_2"],
    },
  );
});

test("checks corporation membership before fetching roles and reuses cached responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const scopedToken = {
    ...token,
    scopes: [
      "esi-corporations.read_corporation_membership.v1",
      "esi-characters.read_corporation_roles.v1",
    ],
  };
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/characters/4201/")) {
      return Response.json({
        alliance_id: 9901,
        birthday: "2020-01-01T00:00:00Z",
        corporation_id: 777,
        description: "",
        gender: "male",
        name: "Test Pilot",
        race_id: 1,
        security_status: 0,
      });
    }
    if (url.endsWith("/corporations/777/members/")) return Response.json([4201]);
    if (url.endsWith("/characters/4201/roles/")) {
      return Response.json({
        roles: ["Factory_Manager"],
        roles_at_base: ["Container_Take_2"],
        roles_at_hq: [],
        roles_at_other: [],
      });
    }
    throw new Error(`Unexpected ESI request: ${url}`);
  };

  const first = await fetchCharacterCorporationAuthorization(4201, scopedToken, 777);
  const second = await fetchCharacterCorporationAuthorization(4201, scopedToken, 777);

  assert.equal(first.authorized, true);
  assert.equal(first.characterInfo.alliance_id, 9901);
  assert.deepEqual(first.roles?.rolesAtBase, ["Container_Take_2"]);
  assert.equal(second.authorized, true);
  assert.equal(requests.length, 3);
  assert.match(requests[1], /\/corporations\/777\/members\/$/);
  assert.match(requests[2], /\/characters\/4201\/roles\/$/);
});

test("treats a corporation member-list authorization failure as no access", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const scopedToken = {
    ...token,
    scopes: ["esi-corporations.read_corporation_membership.v1"],
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/characters/4202/")) {
      return Response.json({
        birthday: "2020-01-01T00:00:00Z",
        corporation_id: 778,
        description: "",
        gender: "male",
        name: "Test Pilot",
        race_id: 1,
        security_status: 0,
      });
    }
    if (url.endsWith("/corporations/778/members/")) return new Response(null, { status: 403 });
    throw new Error(`Unexpected ESI request: ${url}`);
  };

  const result = await fetchCharacterCorporationAuthorization(4202, scopedToken, 778);

  assert.equal(result.authorized, false);
  assert.equal(result.roles, null);
});

test("sends the cached ETag for a non-paginated endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let request = { url: "", headers: new Headers() };
  globalThis.fetch = async (input, init) => {
    request = {
      url: String(input),
      headers: new Headers(init?.headers),
    };
    return new Response(
      JSON.stringify({ skills: [] }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: "new-etag",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<{ skills: unknown[] }>(
    "/characters/42/skills/",
    token,
    "old-etag",
    { paginated: false },
  );

  assert.equal(request.url, "https://esi.evetech.net/latest/characters/42/skills/");
  assert.equal(request.headers.get("if-none-match"), "old-etag");
  assert.equal(request.headers.get("authorization"), "Bearer access-token");
  assert.deepEqual(result.data, { skills: [] });
  assert.equal(result.notModified, false);
  assert.equal(result.headers.get("expires"), "Wed, 26 Aug 2026 17:00:00 GMT");
});

test("sends the cached ETag for corporation structures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let request = { headers: new Headers() };
  globalThis.fetch = async (_input, init) => {
    request = { headers: new Headers(init?.headers) };
    return Response.json(
      [],
      {
        headers: {
          etag: "new-etag",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
        },
      },
    );
  };

  const result = await fetchCorporationStructures(
    {
      ...character,
      corporationId: 777,
      hasDirectorRole: true,
    },
    "old-etag",
  );

  assert.deepEqual(result.structures, []);
  assert.equal(result.notModified, false);
  assert.equal(request.headers.get("if-none-match"), "old-etag");
});

test("fetches active industry jobs and excludes unusable terminal jobs", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json([
      {
        job_id: 1,
        installer_id: 42,
        facility_id: 6001,
        location_id: 6001,
        output_location_id: 6001,
        activity_id: 1,
        blueprint_id: 2,
        blueprint_type_id: 3,
        blueprint_location_id: 6001,
        runs: 10,
        successful_runs: 10,
        product_type_id: 4,
        status: "active",
        start_date: "2026-08-31T00:00:00Z",
        end_date: "2026-09-01T00:00:00Z",
      },
      {
        job_id: 5,
        installer_id: 42,
        facility_id: 6001,
        location_id: 6001,
        output_location_id: 6001,
        activity_id: 1,
        blueprint_id: 6,
        blueprint_type_id: 7,
        blueprint_location_id: 6001,
        runs: 1,
        status: "cancelled",
        start_date: "2026-08-31T00:00:00Z",
        end_date: "2026-09-01T00:00:00Z",
      },
    ]);
  };

  const result = await fetchCharacterIndustryJobs(character);

  assert.equal(requestUrl, "https://esi.evetech.net/latest/characters/42/industry/jobs/");
  assert.deepEqual(
    result.jobs?.map((job) => ({ jobId: job.jobId, status: job.status })),
    [{ jobId: 1, status: "active" }],
  );
});

test("returns response metadata for a 304 without fetching another page", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(
      null,
      {
        status: 304,
        headers: {
          etag: "same-etag",
          "last-modified": "Wed, 26 Aug 2026 16:55:00 GMT",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
          "x-pages": "4",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<number>(
    "/characters/42/assets/",
    token,
    "same-etag",
    { paginated: true },
  );

  assert.deepEqual(requests, ["https://esi.evetech.net/latest/characters/42/assets/?page=1"]);
  assert.equal(result.data, null);
  assert.equal(result.notModified, true);
  assert.equal(result.headers.get("last-modified"), "Wed, 26 Aug 2026 16:55:00 GMT");
});

test("aggregates all pages while preserving first-page metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const page = new URL(url).searchParams.get("page");
    return new Response(
      JSON.stringify(page === "1" ? [1, 2] : [3]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-pages": "2",
          expires: "Wed, 26 Aug 2026 17:00:00 GMT",
        },
      },
    );
  };

  const result = await fetchEsiEndpoint<number>(
    "/characters/42/assets/",
    token,
    undefined,
    { paginated: true },
  );

  assert.deepEqual(result.data, [1, 2, 3]);
  assert.deepEqual(
    requests,
    [
      "https://esi.evetech.net/latest/characters/42/assets/?page=1",
      "https://esi.evetech.net/latest/characters/42/assets/?page=2",
    ],
  );
  assert.equal(result.headers.get("expires"), "Wed, 26 Aug 2026 17:00:00 GMT");
  assert.equal(result.notModified, false);
});

test("maps current ship and location responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const scopedCharacter: CharacterTokenRecord = {
    ...character,
    personalAuth: {
      ...token,
      scopes: ["esi-location.read_location.v1", "esi-location.read_ship_type.v1"],
    },
  };
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return Response.json(
      url.endsWith("/location/")
        ? { solar_system_id: 30_000_142 }
        : { ship_item_id: 9_001, ship_name: "Active ship", ship_type_id: 587 },
    );
  };

  const location = await fetchCharacterLocation(scopedCharacter);
  const ship = await fetchCharacterShip(scopedCharacter);

  assert.deepEqual(location.location, { solarSystemId: 30_000_142 });
  assert.deepEqual(
    ship.ship,
    {
      characterId: 42,
      itemId: 9_001,
      name: "Active ship",
      typeId: 587,
    },
  );
  assert.deepEqual(
    requests,
    [
      "https://esi.evetech.net/latest/characters/42/location/",
      "https://esi.evetech.net/latest/characters/42/ship/",
    ],
  );
});

test("treats a 420 error-limit response as rate limited", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      null,
      {
        status: 420,
        headers: {
          "x-esi-error-limit-reset": "30",
        },
      },
    );

  await assert.rejects(
    fetchEsiEndpoint("/characters/42/assets/", token, undefined, { paginated: false }),
    (error: Error & { status?: number; retryAfter?: string }) => {
      assert.equal(error.status, 420);
      assert.equal(error.retryAfter, "30");
      return true;
    },
  );
});

test("requires current-location scopes before making an ESI request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 500 });
  };

  await assert.rejects(
    fetchCharacterLocation(character),
    (error: Error & { reauthorizeRequired?: boolean }) => {
      assert.match(error.message, /esi-location\.read_location\.v1/);
      assert.equal(error.reauthorizeRequired, true);
      return true;
    },
  );
  await assert.rejects(
    fetchCharacterShip(character),
    (error: Error & { reauthorizeRequired?: boolean }) => {
      assert.match(error.message, /esi-location\.read_ship_type\.v1/);
      assert.equal(error.reauthorizeRequired, true);
      return true;
    },
  );
  assert.equal(requestCount, 0);
});
