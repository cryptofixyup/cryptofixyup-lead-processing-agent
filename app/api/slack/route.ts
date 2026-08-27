import { createHandler } from '@vercel/slack-bolt';
import type { WebClient } from '@slack/web-api';
import { slackApp, receiver } from '@/lib/slack';
import { leadApprovalHook } from '@/workflows/inbound/hooks';

const APPROVAL_TOKEN_PATTERN = /^[0-9a-f-]{36}$/i;

async function resumeApproval(
  approved: boolean,
  token: string,
  client: WebClient,
  channelId?: string,
  messageTs?: string
) {
  if (!APPROVAL_TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid lead approval token.');
  }

  await leadApprovalHook.resume(token, { approved });

  if (!channelId || !messageTs) {
    return;
  }

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
        text: {
          type: 'mrkdwn',
          text: `*${message}*`
        }
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
      client,
      body.channel?.id,
      body.message?.ts
    );
  });
}

export const POST =
  slackApp && receiver
    ? createHandler(slackApp, receiver)
    : () =>
        new Response('Slack credentials not configured', {
          status: 503
        });
