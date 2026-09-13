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

export function renderOrderReceived(data: {
  orderNumber: string;
  locationName: string;
}): RenderedEmail {
  const orderNumber = escapeHtml(data.orderNumber);
  const locationName = escapeHtml(data.locationName);
  return {
    subject: `Mocha House — order ${data.orderNumber} received`,
    html: `<p>Mocha House</p><p>We've received your order <strong>${orderNumber}</strong> at ${locationName}. We'll let you know when it's ready.</p>`,
    text: `Mocha House\n\nWe've received your order ${data.orderNumber} at ${data.locationName}. We'll let you know when it's ready.`,
  };
}

export function renderOrderReady(data: {
  orderNumber: string;
  locationName: string;
}): RenderedEmail {
  const orderNumber = escapeHtml(data.orderNumber);
  const locationName = escapeHtml(data.locationName);
  return {
    subject: `Mocha House — order ${data.orderNumber} is ready`,
    html: `<p>Mocha House</p><p>Your order <strong>${orderNumber}</strong> is ready for pickup at ${locationName}.</p>`,
    text: `Mocha House\n\nYour order ${data.orderNumber} is ready for pickup at ${data.locationName}.`,
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
