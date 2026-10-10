import { headerText } from './email/header-text';

// Milestone 8H — code-owned templates, deliberately not a database-backed
// template system (no editor, no WYSIWYG, no CMS integration — out of
// scope for this slice). Every dynamic value is HTML-escaped before being
// interpolated; nothing here ever renders raw user input.
export type TemplateKey =
  | 'order.received'
  | 'order.ready'
  | 'careers.application.received'
  | 'franchising.inquiry.received';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Security 4A — customer-facing order emails carry the ORDERING business's
// own name (Tenant.name, resolved by the dispatcher from the event's
// tenant), never a hardcoded brand. For Mocha House the wording is
// unchanged.
export function renderOrderReceived(data: {
  businessName: string;
  orderNumber: string;
  locationName: string;
}): RenderedEmail {
  const businessName = escapeHtml(data.businessName);
  const orderNumber = escapeHtml(data.orderNumber);
  const locationName = escapeHtml(data.locationName);
  return {
    subject: headerText(
      `${data.businessName} — order ${data.orderNumber} received`,
    ),
    html: `<p>${businessName}</p><p>We've received your order <strong>${orderNumber}</strong> at ${locationName}. We'll let you know when it's ready.</p>`,
    text: `${data.businessName}\n\nWe've received your order ${data.orderNumber} at ${data.locationName}. We'll let you know when it's ready.`,
  };
}

export function renderOrderReady(data: {
  businessName: string;
  orderNumber: string;
  locationName: string;
}): RenderedEmail {
  const businessName = escapeHtml(data.businessName);
  const orderNumber = escapeHtml(data.orderNumber);
  const locationName = escapeHtml(data.locationName);
  return {
    subject: headerText(
      `${data.businessName} — order ${data.orderNumber} is ready`,
    ),
    html: `<p>${businessName}</p><p>Your order <strong>${orderNumber}</strong> is ready for pickup at ${locationName}.</p>`,
    text: `${data.businessName}\n\nYour order ${data.orderNumber} is ready for pickup at ${data.locationName}.`,
  };
}

export function renderCareersApplicationReceived(data: {
  applicantName: string;
  jobTitleSnapshot: string;
}): RenderedEmail {
  const applicantName = escapeHtml(data.applicantName);
  const jobTitle = escapeHtml(data.jobTitleSnapshot);
  return {
    subject: `New job application — ${data.jobTitleSnapshot}`,
    html: `<p>New job application from <strong>${applicantName}</strong> for <strong>${jobTitle}</strong>. Review it in the Admin Careers screen.</p>`,
    text: `New job application from ${data.applicantName} for ${data.jobTitleSnapshot}. Review it in the Admin Careers screen.`,
  };
}

export function renderFranchiseInquiryReceived(data: {
  inquirerName: string;
  preferredMarket: string;
}): RenderedEmail {
  const inquirerName = escapeHtml(data.inquirerName);
  const preferredMarket = escapeHtml(data.preferredMarket);
  return {
    subject: `New franchise inquiry — ${data.preferredMarket}`,
    html: `<p>New franchise inquiry from <strong>${inquirerName}</strong> for <strong>${preferredMarket}</strong>. Review it in the Admin Franchising screen.</p>`,
    text: `New franchise inquiry from ${data.inquirerName} for ${data.preferredMarket}. Review it in the Admin Franchising screen.`,
  };
}
