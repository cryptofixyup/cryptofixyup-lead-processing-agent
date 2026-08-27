import { createHandler } from '@vercel/slack-bolt';
import { slackApp, receiver } from '@/lib/slack';
import { leadApprovalHook } from '@/workflows/inbound/hooks';

const APPROVAL_TOKEN_PATTERN = /^[0-9a-f-]{36}$/i;

if (slackApp && receiver) {
  slackApp.event('app_mention', async ({ event, client }) => {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Hello <@${event.user}>!`
    });
  });

  const resumeApproval = async (
    approved: boolean,
    token: string,
    client: Parameters<Parameters<typeof slackApp.action>[1]>[0]['client'],
    body: Parameters<Parameters<typeof slackApp.action>[1]>[0]['body']
  ) => {
    if (!APPROVAL_TOKEN_PATTERN.test(token)) {
      throw new Error('Invalid lead approval token.');
    }

    await leadApprovalHook.resume(token, { approved });

    const message = approved
      ? 'Approval received. The workflow will send the approved email.'
      : 'Lead email rejected. The workflow has been closed.';

    if ('channel' in body && body.channel?.id && body.message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
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
  };

  slackApp.action('lead_approved', async ({ action, ack, client, body }) => {
    await ack();
    await resumeApproval(true, action.value, client, body);
  });

  slackApp.action('lead_rejected', async ({ action, ack, client, body }) => {
    await ack();
    await resumeApproval(false, action.value, client, body);
  });
}

export const POST =
  slackApp && receiver
    ? createHandler(slackApp, receiver)
    : () =>
        new Response('Slack credentials not configured', {
          status: 503
        });
