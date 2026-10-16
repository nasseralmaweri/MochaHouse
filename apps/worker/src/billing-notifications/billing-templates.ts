import { headerText } from '../notifications/email/header-text';

// SC3c-3 — CENTERIVO billing notices. Plain, factual and short. They never
// contain a payment link (the business signs in to CENTERIVO to act), never
// an amount or card detail, and never threaten a suspension that billing
// enforcement would not apply (`enforced`).

export type BillingNoticeKind =
  | 'PAYMENT_FAILED'
  | 'GRACE_ENDING'
  | 'BILLING_SUSPENDED'
  | 'ACCESS_RESTORED'
  | 'TRIAL_EXPIRED'
  | 'TRIAL_RECOVERY_ENDING'
  | 'RESTART_CONFIRMED'
  | 'RESTART_UNDER_REVIEW';

export const BILLING_NOTICE_KINDS: readonly BillingNoticeKind[] = [
  'PAYMENT_FAILED',
  'GRACE_ENDING',
  'BILLING_SUSPENDED',
  'ACCESS_RESTORED',
  'TRIAL_EXPIRED',
  'TRIAL_RECOVERY_ENDING',
  'RESTART_CONFIRMED',
  'RESTART_UNDER_REVIEW',
];

export interface BillingNoticePayload {
  deadline: string | null;
  enforced: boolean;
  temporary?: boolean;
  caseId?: string;
}

export function parsePayload(raw: unknown): BillingNoticePayload {
  const value =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    deadline: typeof value.deadline === 'string' ? value.deadline : null,
    enforced: value.enforced === true,
    temporary: value.temporary === true,
    caseId: typeof value.caseId === 'string' ? value.caseId : undefined,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date) + ' UTC'
  );
}

const SIGN_IN =
  'Sign in to CENTERIVO and open Billing to review your subscription.';

export function renderBillingNotice(
  kind: BillingNoticeKind,
  businessName: string,
  payload: BillingNoticePayload,
): { subject: string; text: string; html: string } {
  const name = headerText(businessName).slice(0, 120) || 'your business';
  const deadline = formatDate(payload.deadline);
  let subject: string;
  let lines: string[];
  switch (kind) {
    case 'PAYMENT_FAILED':
      subject = `Payment failed for ${name}`;
      lines = [
        `We couldn't collect the latest CENTERIVO subscription payment for ${name}.`,
        payload.enforced && deadline
          ? `Your business keeps full access until ${deadline}. If the payment isn't completed by then, access will be limited to billing until it is.`
          : 'Your business keeps full access for now.',
        'Please update your payment method or pay the outstanding invoice.',
      ];
      break;
    case 'GRACE_ENDING':
      subject = `Action needed: billing for ${name}`;
      lines = [
        deadline
          ? `The extra time for ${name}'s unpaid CENTERIVO invoice ends on ${deadline}.`
          : `The extra time for ${name}'s unpaid CENTERIVO invoice ends soon.`,
        'After that, access will be limited to billing until payment is completed.',
      ];
      break;
    case 'BILLING_SUSPENDED':
      subject = `${name} is paused for billing`;
      lines = [
        `Because the CENTERIVO subscription for ${name} is unpaid, access is now limited to billing.`,
        'Your data is kept. Completing payment restores access.',
      ];
      break;
    case 'ACCESS_RESTORED':
      subject = payload.temporary
        ? `${name}: temporary access restored`
        : `${name}: access restored`;
      lines = payload.temporary
        ? [
            deadline
              ? `CENTERIVO has given ${name} temporary access until ${deadline}.`
              : `CENTERIVO has given ${name} temporary access.`,
            'The invoice is still unpaid. Please complete payment before then to keep access.',
          ]
        : [`Access to CENTERIVO for ${name} has been restored. Thank you.`];
      break;
    case 'TRIAL_EXPIRED':
      subject = `Your CENTERIVO trial for ${name} has ended`;
      lines = [
        `The free trial for ${name} has ended and nothing was charged.`,
        payload.enforced && deadline
          ? `Your storefront and basic administration stay available until ${deadline}. Premium features are paused. Start a subscription to keep everything running.`
          : 'Start a subscription to keep using CENTERIVO.',
      ];
      break;
    case 'TRIAL_RECOVERY_ENDING':
      subject = `Last day to subscribe for ${name}`;
      lines = [
        deadline
          ? `${name}'s access after its trial ends on ${deadline}.`
          : `${name}'s access after its trial ends soon.`,
        'Start a subscription to keep your business running on CENTERIVO.',
      ];
      break;
    case 'RESTART_CONFIRMED':
      subject = `${name}'s subscription is active`;
      lines = [
        `Your new CENTERIVO subscription for ${name} is confirmed and active.`,
      ];
      break;
    case 'RESTART_UNDER_REVIEW':
      subject = `We're reviewing ${name}'s subscription`;
      lines = [
        `We received a new CENTERIVO subscription for ${name}, but couldn't confirm it automatically.`,
        "Our team is reviewing it. You don't need to pay again; we'll be in touch.",
      ];
      break;
  }
  lines.push(SIGN_IN);
  const text = lines.join('\n\n');
  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
  return { subject: headerText(subject).slice(0, 200), text, html };
}
