import { handleRefreshRequest } from "@/app/api/state/refresh/refreshOwner";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleRefreshRequest(request, "corporation", id);
}
