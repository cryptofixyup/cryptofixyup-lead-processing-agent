import { checkBotId } from 'botid/server';
import { start } from 'workflow/api';
import { createLeadRecord, updateLead } from '@/lib/lead-store';
import { checkLeadRateLimit, getClientKey } from '@/lib/rate-limit';
import { formSchema } from '@/lib/types';
import { workflowInbound } from '@/workflows/inbound';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BODY_BYTES = 16 * 1024;

async function hashPayload(data: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function POST(request: Request) {
  const verification = await checkBotId();

  if (verification.isBot) {
    return Response.json({ error: 'Access denied' }, { status: 403 });
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Request body is too large.' }, { status: 413 });
  }

  try {
    const clientKey = await getClientKey(request);
    const rateLimit = await checkLeadRateLimit(clientKey);

    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-RateLimit-Remaining': '0'
        }
      });
    }

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    if (bodyBytes.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Request body is too large.' }, { status: 413 });
    }

    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const parsedBody = formSchema.safeParse(body);

    if (!parsedBody.success) {
      return Response.json({ error: parsedBody.error.message }, { status: 400 });
    }

    const suppliedIdempotencyKey = request.headers.get('Idempotency-Key');
    if (
      suppliedIdempotencyKey &&
      !IDEMPOTENCY_KEY_PATTERN.test(suppliedIdempotencyKey)
    ) {
      return Response.json(
        { error: 'Invalid Idempotency-Key.' },
        { status: 400 }
      );
    }

    const idempotencyKey =
      suppliedIdempotencyKey || (await hashPayload(parsedBody.data));
    const leadId = crypto.randomUUID();

    const { record, created } = await createLeadRecord({
      id: leadId,
      idempotencyKey,
      email: parsedBody.data.email,
      name: parsedBody.data.name,
      phone: parsedBody.data.phone || '',
      company: parsedBody.data.company || '',
      message: parsedBody.data.message
    });

    if (!created) {
      return Response.json(
        {
          message: 'Lead already accepted.',
          leadId: record.id,
          runId: record.runId,
          status: record.status
        },
        {
          status: 200,
          headers: { 'X-RateLimit-Remaining': String(rateLimit.remaining) }
        }
      );
    }

    const run = await start(workflowInbound, [parsedBody.data, record.id]);

    await updateLead(record.id, { status: 'started', runId: run.runId }).catch(
      (stateError) => {
        console.error('[lead-submit] state update delayed', {
          leadId: record.id,
          runId: run.runId,
          error:
            stateError instanceof Error ? stateError.message : 'unknown error'
        });
      }
    );

    return Response.json(
      {
        message: 'Lead accepted.',
        leadId: record.id,
        runId: run.runId,
        status: 'started'
      },
      {
        status: 202,
        headers: { 'X-RateLimit-Remaining': String(rateLimit.remaining) }
      }
    );
  } catch (error) {
    console.error('[lead-submit] failed', {
      error: error instanceof Error ? error.message : 'unknown error'
    });

    return Response.json(
      { error: 'Unable to accept lead submission.' },
      { status: 503 }
    );
  }
}
