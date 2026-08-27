import { FormSchema } from '@/lib/types';
import { leadApprovalHook } from './hooks';
import {
  stepCreateApprovalToken,
  stepHumanFeedback,
  stepQualify,
  stepResearch,
  stepSendEmail,
  stepWriteEmail
} from './steps';

/**
 * Durable inbound lead workflow.
 *
 * Qualified leads are researched, drafted, sent to Slack for human approval,
 * and the workflow then pauses until the approval hook is resumed.
 */
export const workflowInbound = async (data: FormSchema) => {
  'use workflow';

  const research = await stepResearch(data);
  const qualification = await stepQualify(data, research);

  if (
    qualification.category !== 'QUALIFIED' &&
    qualification.category !== 'FOLLOW_UP'
  ) {
    return { status: 'closed', category: qualification.category };
  }

  const emailDraft = await stepWriteEmail(research, qualification);
  const approvalToken = await stepCreateApprovalToken();
  const approvalHook = leadApprovalHook.create({ token: approvalToken });

  await stepHumanFeedback(
    data.email,
    research,
    emailDraft,
    qualification,
    approvalToken
  );

  const { approved } = await approvalHook;

  if (!approved) {
    return { status: 'rejected', category: qualification.category };
  }

  const delivery = await stepSendEmail(data.email, emailDraft);

  return {
    status: 'sent',
    category: qualification.category,
    delivery
  };
};
