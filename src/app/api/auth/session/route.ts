import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";

export async function GET(request: Request) {
	try {
		const session = await getSessionFromRequest(request);
		if (!session) return NextResponse.json({ authenticated: false, characters: [] });
		const records = await getCharacters();
		const characters = records
			.filter((record) => session.characterIds.includes(record.characterId))
			.map(({ characterId, characterName, corporationId, hasDirectorRole, corpAuthCompleted }) => ({
				characterId,
				characterName,
				corporationId,
				hasDirectorRole: Boolean(hasDirectorRole),
				corpAuthCompleted: Boolean(corpAuthCompleted),
			}));
		return NextResponse.json({ authenticated: characters.length > 0, characters });
	} catch {
		return NextResponse.json({ authenticated: false, characters: [] });
	}
}