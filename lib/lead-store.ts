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
  approvalTokenHash: z.string().length(64).optional(),
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
const APPROVAL_LOCK_TTL_SECONDS = 60;
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

export async function hashApprovalToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
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

export async function getLeadByApprovalToken(
  token: string
): Promise<LeadRecord | null> {
  const tokenHash = await hashApprovalToken(token);
  const leadId = await redisCommand<string | null>([
    'GET',
    `${KEY_PREFIX}approval:${tokenHash}`
  ]);

  if (!leadId) return null;
  return getLead(leadId);
}

const UPDATE_LEAD_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return { 'NOT_FOUND' } end

local record = cjson.decode(current)
local expectedStatus = ARGV[1]
local patch = cjson.decode(ARGV[2])

if expectedStatus ~= '' and record.status ~= expectedStatus then
  return { 'CONFLICT', record.status }
end

local previousApprovalTokenHash = record.approvalTokenHash
for key, value in pairs(patch) do
  record[key] = value
end
record.updatedAt = ARGV[3]

local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])

if patch.approvalTokenHash then
  if previousApprovalTokenHash and previousApprovalTokenHash ~= patch.approvalTokenHash then
    redis.call('DEL', 'lead-agent:approval:' .. previousApprovalTokenHash)
  end
  redis.call('SET', 'lead-agent:approval:' .. patch.approvalTokenHash, ARGV[5], 'EX', ARGV[4])
end

return { 'OK', encoded }
`;

export async function updateLead(
  id: string,
  patch: Partial<Pick<LeadRecord, 'status' | 'runId' | 'approvalTokenHash' | 'qualification' | 'delivery'>>,
  expectedStatus?: LeadStatus
): Promise<LeadRecord> {
  const validatedPatch = z
    .object({
      status: leadStatusSchema.optional(),
      runId: z.string().max(200).optional(),
      approvalTokenHash: z.string().length(64).optional(),
      qualification: leadRecordSchema.shape.qualification.optional(),
      delivery: leadRecordSchema.shape.delivery.optional()
    })
    .strict()
    .parse(patch);

  const result = await redisCommand<string[]>([
    'EVAL',
    UPDATE_LEAD_LUA,
    '1',
    `${KEY_PREFIX}lead:${id}`,
    expectedStatus || '',
    JSON.stringify(validatedPatch),
    new Date().toISOString(),
    LEAD_TTL_SECONDS,
    id
  ]);

  if (result[0] === 'NOT_FOUND') {
    throw new Error(`Lead ${id} not found.`);
  }

  if (result[0] === 'CONFLICT') {
    throw new Error(
      `Lead ${id} state conflict: expected ${expectedStatus}, found ${result[1]}.`
    );
  }

  const updated = leadRecordSchema.parse(JSON.parse(result[1]));
  return updated;
}

export async function claimApproval(leadId: string): Promise<boolean> {
  const result = await redisCommand<string | null>([
    'SET',
    `${KEY_PREFIX}approval-lock:${leadId}`,
    '1',
    'NX',
    'EX',
    APPROVAL_LOCK_TTL_SECONDS
  ]);
  return result === 'OK';
}

export async function releaseApprovalClaim(leadId: string): Promise<void> {
  await redisCommand<string | null>([
    'DEL',
    `${KEY_PREFIX}approval-lock:${leadId}`
  ]);
}
