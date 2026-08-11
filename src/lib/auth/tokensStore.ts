import { randomUUID } from "node:crypto";
import { initStorage } from "../storage";
import { AccountRecord, CharacterTokenRecord, SessionRecord, TokenSet } from "./model";

function normalizeTokenSet(value: Partial<TokenSet> | undefined): TokenSet | null {
	if (!value?.accessToken || !value.refreshToken || !value.accessTokenExpiresAt) return null;
	return {
		accessToken: value.accessToken,
		refreshToken: value.refreshToken,
		accessTokenExpiresAt: value.accessTokenExpiresAt,
		scopes: Array.isArray(value.scopes) ? value.scopes : [],
		lastUsedAt: value.lastUsedAt ?? 0,
	};
}

function normalizeCharacter(value: unknown): CharacterTokenRecord | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<CharacterTokenRecord> & {
		refreshToken?: string;
		accessToken?: string;
		accessTokenExpiresAt?: string;
		scopes?: string[];
	};
	if (!Number.isInteger(record.characterId) || typeof record.characterName !== "string") return null;
	const characterId = record.characterId as number;
	const personalAuth = normalizeTokenSet(record.personalAuth) ?? normalizeTokenSet({
		accessToken: record.accessToken,
		refreshToken: record.refreshToken,
		accessTokenExpiresAt: record.accessTokenExpiresAt,
		scopes: record.scopes,
	});
	if (!personalAuth) return null;
	return {
		characterId,
		characterName: record.characterName,
		accountId: record.accountId,
		personalAuth,
		...(normalizeTokenSet(record.corpAuth) ? { corpAuth: normalizeTokenSet(record.corpAuth)! } : {}),
		corporationId: record.corporationId,
		corporationRoles: Array.isArray(record.corporationRoles) ? record.corporationRoles : [],
		hasDirectorRole: record.hasDirectorRole,
		hasAccountantRole: record.hasAccountantRole,
		hasTraderRole: record.hasTraderRole,
		corpAuthCompleted: record.corpAuthCompleted,
	};
}

export async function getCharacters(): Promise<CharacterTokenRecord[]> {
	const storage = await initStorage();
	const raw = (await storage.getItem("characters")) as unknown[] | undefined;
	const records = (raw ?? []).map(normalizeCharacter).filter((record): record is CharacterTokenRecord => record !== null);
	if (JSON.stringify(raw ?? []) !== JSON.stringify(records)) await storage.setItem("characters", records);
	return records;
}
export async function saveCharacters(records: CharacterTokenRecord[]) { await (await initStorage()).setItem("characters", records); }
export async function getSessions(): Promise<SessionRecord[]> {
	const records = (await (await initStorage()).getItem("sessions")) as SessionRecord[] | undefined;
	return records ?? [];
}
export async function saveSessions(records: SessionRecord[]) { await (await initStorage()).setItem("sessions", records); }

export async function getAccounts(): Promise<AccountRecord[]> {
	const storage = await initStorage();
	const characters = await getCharacters();
	const stored = (await storage.getItem("accounts")) as AccountRecord[] | undefined;
	const accounts = stored ?? [];
	const accountById = new Map(accounts.map((account) => [account.accountId, account]));
	const now = new Date().toISOString();
	for (const character of characters) {
		let account = character.accountId ? accountById.get(character.accountId) : undefined;
		if (!account) {
			account = {
				accountId: character.accountId ?? randomUUID(),
				characterIds: [],
				createdAt: now,
				lastSeenAt: now,
			};
			accountById.set(account.accountId, account);
		}
		if (!account.characterIds.includes(character.characterId)) account.characterIds.push(character.characterId);
		if (!character.accountId) {
			character.accountId = account.accountId;
			await upsertCharacter(character);
		}
	}
	const normalized = [...accountById.values()];
	if (JSON.stringify(stored ?? []) !== JSON.stringify(normalized)) await storage.setItem("accounts", normalized);
	return normalized;
}

export async function getAccount(accountId: string) {
	return (await getAccounts()).find((account) => account.accountId === accountId) ?? null;
}

export async function getAccountForCharacter(characterId: number) {
	const character = await getCharacter(characterId);
	if (character?.accountId) return getAccount(character.accountId);
	return (await getAccounts()).find((account) => account.characterIds.includes(characterId)) ?? null;
}

export async function createAccount(): Promise<AccountRecord> {
	const now = new Date().toISOString();
	const account = { accountId: randomUUID(), characterIds: [], createdAt: now, lastSeenAt: now };
	const storage = await initStorage();
	const accounts = await getAccounts();
	await storage.setItem("accounts", [...accounts, account]);
	return account;
}

export async function saveAccount(record: AccountRecord) {
	const accounts = await getAccounts();
	const index = accounts.findIndex((account) => account.accountId === record.accountId);
	if (index === -1) accounts.push(record);
	else accounts[index] = record;
	await (await initStorage()).setItem("accounts", accounts);
}

export async function getCharacter(characterId: number) {
	return (await getCharacters()).find((record) => record.characterId === characterId) ?? null;
}

export async function upsertCharacter(record: CharacterTokenRecord) {
	const records = await getCharacters();
	const index = records.findIndex((existing) => existing.characterId === record.characterId);
	if (index === -1) records.push(record);
	else records[index] = record;
	await saveCharacters(records);
}

export async function getSession(sessionId: string) {
	return (await getSessions()).find((session) => session.sessionId === sessionId) ?? null;
}
export async function deleteSession(sessionId: string) {
	const sessions = await getSessions();
	await saveSessions(sessions.filter((session) => session.sessionId !== sessionId));
}

export async function saveSession(record: SessionRecord) {
	const sessions = await getSessions();
	const index = sessions.findIndex((session) => session.sessionId === record.sessionId);
	if (index === -1) sessions.push(record);
	else sessions[index] = record;
	await saveSessions(sessions);
}