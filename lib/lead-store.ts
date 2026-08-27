import { z } from 'zod';

const leadStatusSchema = z.enum([
  'queued',
  'started',
  'researching',
  'qualified',
  'approval_pending',
  'rejected',
  'sent',
  'closed',
  'failed'
]);

export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const leadRecordSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128),
  email: z.email(),
  name: z.string().min(2).max(50),
  phone: z.string().max(40),
  company: z.string().max(200),
  message: z.string().min(10).max(500),
  status: leadStatusSchema,
  runId: z.string().max(200).optional(),
  qualification: z
    .object({
      category: z.enum(['QUALIFIED', 'UNQUALIFIED', 'SUPPORT', 'FOLLOW_UP']),
      reason: z.string().max(2000)
    })
    .optional(),
  delivery: z
    .object({
      provider: z.literal('resend'),
      messageId: z.string().min(1)
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type LeadRecord = z.infer<typeof leadRecordSchema>;

const KEY_PREFIX = 'lead-agent:';
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEAD_TTL_SECONDS = 30 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 5000;

function getConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for durable lead state.'
    );
  }

  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand<T>(command: unknown[]): Promise<T> {
  const { url, token } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command),
      cache: 'no-store',
      signal: controller.signal
    });

    const payload = (await response.json()) as { result?: T; error?: string };

    if (!response.ok || payload.error) {
      throw new Error(
        `Lead state store rejected the request (${response.status}): ${
          payload.error || 'unknown error'
        }`
      );
    }

    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createLeadRecord(
  record: Omit<LeadRecord, 'status' | 'createdAt' | 'updatedAt'>
): Promise<{ record: LeadRecord; created: boolean }> {
  const now = new Date().toISOString();
  const lead = leadRecordSchema.parse({
    ...record,
    status: 'queued',
    createdAt: now,
    updatedAt: now
  });

  const reservation = await redisCommand<string | null>([
    'SET',
    `${KEY_PREFIX}idempotency:${record.idempotencyKey}`,
    record.id,
    'NX',
    'EX',
    IDEMPOTENCY_TTL_SECONDS
  ]);

  if (reservation !== 'OK') {
    const existing = await getLeadByIdempotencyKey(record.idempotencyKey);
    if (!existing) {
      throw new Error('Idempotency reservation exists without a lead record.');
    }
    return { record: existing, created: false };
  }

  try {
    await redisCommand<string>([
      'SET',
      `${KEY_PREFIX}lead:${record.id}`,
      JSON.stringify(lead),
      'EX',
      LEAD_TTL_SECONDS
    ]);
    return { record: lead, created: true };
  } catch (error) {
    await redisCommand<string | null>([
      'DEL',
      `${KEY_PREFIX}idempotency:${record.idempotencyKey}`
    ]).catch(() => undefined);
    throw error;
  }
}

export async function getLeadByIdempotencyKey(
  idempotencyKey: string
): Promise<LeadRecord | null> {
  const leadId = await redisCommand<string | null>([
    'GET',
    `${KEY_PREFIX}idempotency:${idempotencyKey}`
  ]);

  if (!leadId) return null;
  return getLead(leadId);
}

export async function getLead(id: string): Promise<LeadRecord | null> {
  const value = await redisCommand<string | null>([
    'GET',
    `${KEY_PREFIX}lead:${id}`
  ]);

  if (!value) return null;
  return leadRecordSchema.parse(JSON.parse(value));
}

export async function updateLead(
  id: string,
  patch: Partial<Pick<LeadRecord, 'status' | 'runId' | 'qualification' | 'delivery'>>
): Promise<LeadRecord> {
  const current = await getLead(id);
  if (!current) throw new Error(`Lead ${id} not found.`);

  const updated = leadRecordSchema.parse({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });

  await redisCommand<string>([
    'SET',
    `${KEY_PREFIX}lead:${id}`,
    JSON.stringify(updated),
    'EX',
    LEAD_TTL_SECONDS
  ]);

  return updated;
}
