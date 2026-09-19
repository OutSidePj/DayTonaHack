import { subscribe } from "../../../../../lib/events";
import { snapshot } from "../../../../../lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  let record;
  try {
    record = await snapshot(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      send({ type: "snapshot", deployment: { ...record, preview_token: record.preview_token ? "redacted" : null } });

      if (record.status === "live" || record.status === "failed") {
        send({ type: "done", status: record.status });
        return;
      }

      const unsub = subscribe(id, (event, next) => {
        send({
          type: "stage",
          ...event,
          deployment: { ...next, preview_token: next.preview_token ? "redacted" : null },
        });
        if (next.status === "live" || next.status === "failed") {
          send({ type: "done", status: next.status });
          unsub();
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
