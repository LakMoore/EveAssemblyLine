import { handleRefreshRequest } from "@/app/api/state/refresh/refreshOwner";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleRefreshRequest(request, "character", id);
}
