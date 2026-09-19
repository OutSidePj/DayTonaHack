import { startDeploy } from "../../../lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { repoUrl?: string; gpu?: boolean };
  try {
    body = (await request.json()) as { repoUrl?: string; gpu?: boolean };
  } catch {
    return Response.json({ error: "JSON body required" }, { status: 400 });
  }

  try {
    const { id } = await startDeploy({
      repoUrl: body.repoUrl ?? "",
      gpu: Boolean(body.gpu),
    });
    return Response.json({ id }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
}
