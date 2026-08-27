import {
  humanFeedback,
  qualify,
  researchAgent,
  writeEmail
} from '@/lib/services';
import { FormSchema, QualificationSchema } from '@/lib/types';

/**
 * step to qualify the lead
 */
export const stepQualify = async (data: FormSchema, research: string) => {
  'use step';

  const qualification = await qualify(data, research);
  return qualification;
};

/**
 * step to research the lead
 */
export const stepResearch = async (data: FormSchema) => {
  'use step';

  const { text: research } = await researchAgent.generate({
    prompt: `Research the lead: ${JSON.stringify(data)}`
  });

  return research;
};

/**
 * step to write an email for the lead
 */
export const stepWriteEmail = async (
  research: string,
  qualification: QualificationSchema
) => {
  'use step';

  const email = await writeEmail(research, qualification);
  return email;
};

/**
 * Generate an opaque approval capability outside the workflow's deterministic
 * orchestration code. The token contains no lead PII and is safe to put in a
 * Slack button value.
 */
export const stepCreateApprovalToken = async () => {
  'use step';

  return crypto.randomUUID();
};

/**
 * Send the research and qualification to the human for approval in Slack.
 */
export const stepHumanFeedback = async (
  research: string,
  email: string,
  qualification: QualificationSchema,
  approvalToken: string
) => {
  'use step';

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
    throw new Error(
      'Slack approval is required but SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET is not configured.'
    );
  }

  const slackMessage = await humanFeedback(
    research,
    email,
    qualification,
    approvalToken
  );
  return slackMessage;
};

/**
 * Send the approved email.
 */
export const stepSendEmail = async (to: string, body: string) => {
  'use step';

  const { sendEmail } = await import('@/lib/services');
  return sendEmail(to, body);
};
