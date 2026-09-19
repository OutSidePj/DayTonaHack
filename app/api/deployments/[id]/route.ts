import { snapshot, teardownDeploy } from "../../../../lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicSnapshot(id: string, record: Awaited<ReturnType<typeof snapshot>>) {
  return {
    ...record,
    preview_token: record.preview_token ? "redacted" : null,
    id,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const record = await snapshot(id);
    return Response.json(publicSnapshot(id, record));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    await teardownDeploy(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
