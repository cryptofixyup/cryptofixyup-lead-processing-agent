import { FormSchema } from '@/lib/types';
import { leadApprovalHook } from './hooks';
import {
  stepCreateApprovalToken,
  stepHashApprovalToken,
  stepHumanFeedback,
  stepQualify,
  stepResearch,
  stepSendEmail,
  stepUpdateLead,
  stepWriteEmail
} from './steps';

/**
 * Durable inbound lead workflow with persistent lifecycle state.
 */
export const workflowInbound = async (data: FormSchema, leadId: string) => {
  'use workflow';

  try {
    await stepUpdateLead(leadId, { status: 'researching' }, 'started');
    const research = await stepResearch(data);
    const qualification = await stepQualify(data, research);

    const nextStatus =
      qualification.category === 'QUALIFIED' ||
      qualification.category === 'FOLLOW_UP'
        ? 'qualified'
        : 'closed';

    await stepUpdateLead(
      leadId,
      { status: nextStatus, qualification },
      'researching'
    );

    if (nextStatus === 'closed') {
      return { status: 'closed', category: qualification.category };
    }

    const emailDraft = await stepWriteEmail(research, qualification);
    const approvalToken = await stepCreateApprovalToken();
    const approvalTokenHash = await stepHashApprovalToken(approvalToken);
    const approvalHook = leadApprovalHook.create({ token: approvalToken });

    await stepUpdateLead(
      leadId,
      { status: 'approval_pending', approvalTokenHash },
      'qualified'
    );

    await stepHumanFeedback(
      data.email,
      research,
      emailDraft,
      qualification,
      approvalToken
    );

    const { approved } = await approvalHook;

    if (!approved) {
      await stepUpdateLead(
        leadId,
        { status: 'rejected', approvalTokenHash: undefined },
        'approval_pending'
      );
      return { status: 'rejected', category: qualification.category };
    }

    const delivery = await stepSendEmail(data.email, emailDraft, leadId);
    await stepUpdateLead(
      leadId,
      { status: 'sent', delivery, approvalTokenHash: undefined },
      'approval_pending'
    );

    return {
      status: 'sent',
      category: qualification.category,
      delivery
    };
  } catch (error) {
    await stepUpdateLead(leadId, { status: 'failed' }).catch((stateError) => {
      console.error('[lead-workflow] failed to persist failure state', stateError);
    });

    throw error;
  }
};
