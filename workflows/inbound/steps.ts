import {
  humanFeedback,
  qualify,
  researchAgent,
  writeEmail
} from '@/lib/services';
import {
  hashApprovalToken,
  updateLead,
  type LeadRecord
} from '@/lib/lead-store';
import { FormSchema, QualificationSchema } from '@/lib/types';

export const stepUpdateLead = async (
  leadId: string,
  patch: Partial<
    Pick<
      LeadRecord,
      'status' | 'runId' | 'approvalTokenHash' | 'qualification' | 'delivery'
    >
  >
) => {
  'use step';

  return updateLead(leadId, patch);
};

export const stepQualify = async (data: FormSchema, research: string) => {
  'use step';

  return qualify(data, research);
};

export const stepResearch = async (data: FormSchema) => {
  'use step';

  const { text: research } = await researchAgent.generate({
    prompt: `Research the lead: ${JSON.stringify(data)}`
  });

  return research;
};

export const stepWriteEmail = async (
  research: string,
  qualification: QualificationSchema
) => {
  'use step';

  return writeEmail(research, qualification);
};

export const stepCreateApprovalToken = async () => {
  'use step';

  return crypto.randomUUID();
};

export const stepHashApprovalToken = async (token: string) => {
  'use step';

  return hashApprovalToken(token);
};

export const stepHumanFeedback = async (
  leadEmail: string,
  research: string,
  emailDraft: string,
  qualification: QualificationSchema,
  approvalToken: string
) => {
  'use step';

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
    throw new Error(
      'Slack approval is required but SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET is not configured.'
    );
  }

  return humanFeedback(
    leadEmail,
    research,
    emailDraft,
    qualification,
    approvalToken
  );
};

export const stepSendEmail = async (
  to: string,
  body: string,
  leadId: string
) => {
  'use step';

  const { sendEmail } = await import('@/lib/services');
  return sendEmail(to, body, leadId);
};
