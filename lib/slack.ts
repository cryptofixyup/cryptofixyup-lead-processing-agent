import { App, LogLevel } from '@slack/bolt';
import { VercelReceiver } from '@vercel/slack-bolt';

const logLevel =
  process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO;

const hasSlackCredentials = Boolean(
  process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET
);

if (!hasSlackCredentials) {
  console.warn(
    'Slack credentials are not configured. Slack integration is disabled.'
  );
}

export const receiver = hasSlackCredentials
  ? new VercelReceiver({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      logLevel
    })
  : null;

export const slackApp = hasSlackCredentials
  ? new App({
      token: process.env.SLACK_BOT_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      receiver: receiver!,
      deferInitialization: true,
      logLevel
    })
  : null;

/**
 * Send an approval card. The token is an opaque Workflow hook capability;
 * never put lead PII or the generated email in the button value.
 */
export async function sendSlackMessageWithButtons(
  channel: string,
  text: string,
  approvalToken: string
): Promise<{ messageTs: string; channel: string }> {
  if (!slackApp) {
    throw new Error(
      'Slack app is not initialized. Configure SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.'
    );
  }

  if (!approvalToken || approvalToken.length > 200) {
    throw new Error('Invalid approval token.');
  }

  await slackApp.client.auth.test();

  const result = await slackApp.client.chat.postMessage({
    channel,
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve',
              emoji: true
            },
            style: 'primary',
            action_id: 'lead_approved',
            value: approvalToken
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Reject',
              emoji: true
            },
            style: 'danger',
            action_id: 'lead_rejected',
            value: approvalToken
          }
        ]
      }
    ]
  });

  if (!result.ok || !result.ts || !result.channel) {
    throw new Error('Failed to send Slack approval message.');
  }

  return {
    messageTs: result.ts,
    channel: result.channel
  };
}
