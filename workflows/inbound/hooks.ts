import { defineHook } from 'workflow';
import { z } from 'zod';

/**
 * Durable human approval gate for outbound lead email.
 *
 * The token is a capability: it is generated per workflow run and placed in
 * Slack button values. Slack's signed webhook authenticates the caller, while
 * the hook token identifies the exact suspended workflow waiting for approval.
 */
export const leadApprovalHook = defineHook({
  schema: z.object({
    approved: z.boolean()
  })
});
