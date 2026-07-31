import { initStorage } from "../storage";
import { CharacterTokenRecord, SessionRecord } from "./model";

export async function getCharacters(): Promise<CharacterTokenRecord[]> {
	const records = await (await initStorage()).getItem<CharacterTokenRecord[]>("characters");
	return records ?? [];
}
export async function saveCharacters(records: CharacterTokenRecord[]) { await (await initStorage()).setItem("characters", records); }
export async function getSessions(): Promise<SessionRecord[]> {
	const records = await (await initStorage()).getItem<SessionRecord[]>("sessions");
	return records ?? [];
}
export async function saveSessions(records: SessionRecord[]) { await (await initStorage()).setItem("sessions", records); }