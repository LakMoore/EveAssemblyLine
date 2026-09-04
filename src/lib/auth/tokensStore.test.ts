import assert from "node:assert/strict";
import test from "node:test";
import { corporationRefreshScopes } from "../esi/corporationAccess";
import type { CharacterTokenRecord } from "./model";
import { selectCorporationDirector } from "./tokensStore";

function character(
  characterId: number,
  options: Partial<CharacterTokenRecord> = {},
): CharacterTokenRecord {
  return {
    characterId,
    characterName: `Character ${characterId}`,
    corporationId: 100,
    hasDirectorRole: true,
    allowCorpRefreshOptIn: false,
    personalAuth: {
      accessToken: `access-${characterId}`,
      refreshToken: `refresh-${characterId}`,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scopes: [...corporationRefreshScopes],
      lastUsedAt: 0,
    },
    ...options,
  };
}

test("does not select a non-opted-in Director when opt-in is enabled", () => {
  const selected = selectCorporationDirector([character(10)], 100, 20, true);
  assert.equal(selected, null);
});

test("selects the lowest opted-in Director for a non-Director refresh", () => {
  const selected = selectCorporationDirector(
    [
      character(20, { allowCorpRefreshOptIn: true }),
      character(10, { allowCorpRefreshOptIn: true }),
    ],
    100,
    30,
    true,
  );
  assert.equal(selected?.characterId, 10);
});

test("selects any eligible Director when opt-in is disabled", () => {
  const selected = selectCorporationDirector([character(20), character(10)], 100, 30, false);
  assert.equal(selected?.characterId, 10);
});

test("allows a Director to use their own token without opting in", () => {
  const selected = selectCorporationDirector([character(10)], 100, 10, true);
  assert.equal(selected?.characterId, 10);
});

test("does not bypass scope checks for a Director's own refresh", () => {
  const selected = selectCorporationDirector(
    [character(10, { personalAuth: { ...character(10).personalAuth, scopes: [] } })],
    100,
    10,
    true,
  );
  assert.equal(selected, null);
});
