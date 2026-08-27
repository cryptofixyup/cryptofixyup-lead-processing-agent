import { createHandler } from '@vercel/slack-bolt';
import type { WebClient } from '@slack/web-api';
import {
  claimApproval,
  getLeadByApprovalToken,
  releaseApprovalClaim
} from '@/lib/lead-store';
import { slackApp, receiver } from '@/lib/slack';
import { leadApprovalHook } from '@/workflows/inbound/hooks';

const APPROVAL_TOKEN_PATTERN = /^[0-9a-f-]{36}$/i;

function getAuthorizedApproverIds(): Set<string> {
  return new Set(
    (process.env.SLACK_APPROVER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

async function resumeApproval(
  approved: boolean,
  token: string,
  approverId: string,
  client: WebClient,
  channelId?: string,
  messageTs?: string
) {
  if (!APPROVAL_TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid lead approval token.');
  }

  const authorizedApprovers = getAuthorizedApproverIds();
  if (authorizedApprovers.size === 0 || !authorizedApprovers.has(approverId)) {
    throw new Error('Slack user is not authorized to approve lead email.');
  }

  const lead = await getLeadByApprovalToken(token);
  if (!lead) {
    throw new Error('Approval request not found or expired.');
  }

  if (lead.status !== 'approval_pending') {
    throw new Error(`Approval is not pending for lead ${lead.id}.`);
  }

  const claimed = await claimApproval(lead.id);
  if (!claimed) {
    throw new Error('Approval has already been processed.');
  }

  try {
    await leadApprovalHook.resume(token, { approved });
  } catch (error) {
    await releaseApprovalClaim(lead.id).catch(() => undefined);
    throw error;
  }

  if (!channelId || !messageTs) return;

  const message = approved
    ? 'Approval received. The workflow will send the approved email.'
    : 'Lead email rejected. The workflow has been closed.';

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: message,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${message}*` }
      }
    ]
  });
}

if (slackApp && receiver) {
  slackApp.event('app_mention', async ({ event, client }) => {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Hello <@${event.user}>!`
    });
  });

  slackApp.action('lead_approved', async ({ action, ack, client, body }) => {
    await ack();
    await resumeApproval(
      true,
      action.value,
      body.user.id,
      client,
      body.channel?.id,
      body.message?.ts
    );
  });

  slackApp.action('lead_rejected', async ({ action, ack, client, body }) => {
    await ack();
    await resumeApproval(
      false,
      action.value,
      body.user.id,
      client,
      body.channel?.id,
      body.message?.ts
    );
  });
}

export const POST =
  slackApp && receiver
    ? createHandler(slackApp, receiver)
    : () => new Response('Slack credentials not configured', { status: 503 });
