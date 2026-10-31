import { PRODUCT_NAME, SEAT_PRICE_CENTS, formatDay, formatUsd } from "@/lib/billing/config";

// Every email the app sends, as plain text plus a simple HTML copy of the
// same words (README "Trial, billing and emails"). The copy is plain ASCII:
// no em dashes or special characters. Each kind's params are JSON (they
// travel in a pg-boss job); dates are ISO strings. The dedupe key that
// makes each kind go out once per tenant is chosen by the sender
// (src/lib/billing/daily.ts, src/lib/billing/stripe-webhook.ts): a trial
// reminder is keyed by the trial end it announces, a receipt by its invoice.

export type EmailKind =
  | "welcome"
  | "trial_reminder_7d"
  | "trial_reminder_1d"
  | "trial_ended"
  | "payment_failed"
  | "subscription_confirmed"
  | "payment_receipt"
  | "renewal_upcoming"
  | "cancel_reminder"
  | "lapsed_reminder";

/** Links are null when CONNECTOR_PUBLIC_ORIGIN is not set; the text then names the page instead. */
type Links = { billingUrl: string | null };

export type EmailParams = {
  /** trialEndsAt is null for a firm that got no free month (its creator had used one): the email says to subscribe instead. */
  welcome: Links & { firmName: string; trialEndsAt: string | null; connectUrl: string | null; connectorUrl: string | null };
  trial_reminder_7d: Links & { firmName: string; trialEndsAt: string; seats: number };
  trial_reminder_1d: Links & { firmName: string; trialEndsAt: string; seats: number };
  trial_ended: Links & { firmName: string; trialEndsAt: string };
  payment_failed: Links & { firmName: string; graceEndsAt: string; amountCents: number | null; invoiceUrl: string | null };
  subscription_confirmed: Links & { firmName: string; seats: number; firstChargeAt: string | null };
  payment_receipt: Links & {
    firmName: string;
    amountCents: number;
    currency: string;
    periodStart: string | null;
    periodEnd: string | null;
    seats: number | null;
    invoiceNumber: string | null;
    invoiceUrl: string | null;
  };
  renewal_upcoming: Links & { firmName: string; renewsAt: string; seats: number };
  cancel_reminder: Links & { firmName: string; endsAt: string };
  lapsed_reminder: Links & { firmName: string; lockedAt: string; sequence: number };
};

export type RenderedEmail = { subject: string; text: string; html: string };

/** A paragraph of the email: plain words, or a labeled link. */
type Paragraph = string | { label: string; url: string | null; fallback: string };

const SIGN_OFF = `${PRODUCT_NAME}`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function day(iso: string): string {
  return formatDay(new Date(iso));
}

function monthly(seats: number): string {
  return `${formatUsd(SEAT_PRICE_CENTS * seats)} a month for ${seats} ${seats === 1 ? "user" : "users"}`;
}

/** The text and HTML bodies from the same paragraphs, so both say exactly the same thing. */
function compose(subject: string, paragraphs: Paragraph[]): RenderedEmail {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const p of paragraphs) {
    if (typeof p === "string") {
      textParts.push(p);
      htmlParts.push(`<p>${escapeHtml(p)}</p>`);
    } else if (p.url) {
      textParts.push(`${p.label}: ${p.url}`);
      htmlParts.push(`<p>${escapeHtml(p.label)}: <a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a></p>`);
    } else {
      textParts.push(p.fallback);
      htmlParts.push(`<p>${escapeHtml(p.fallback)}</p>`);
    }
  }
  textParts.push(SIGN_OFF);
  htmlParts.push(`<p>${escapeHtml(SIGN_OFF)}</p>`);
  const html =
    `<!DOCTYPE html><html><body style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #171717;">` +
    htmlParts.join("\n") +
    `</body></html>`;
  return { subject, text: textParts.join("\n\n"), html };
}

function billingLink(url: string | null, label = "Billing page"): Paragraph {
  return { label, url, fallback: `${label}: open ${PRODUCT_NAME}, then Billing.` };
}

const RENDERERS: { [K in EmailKind]: (p: EmailParams[K]) => RenderedEmail } = {
  welcome: (p) =>
    compose(p.trialEndsAt ? `Welcome to ${PRODUCT_NAME}: your free month has started` : `Welcome to ${PRODUCT_NAME}`, [
      `Hello,`,
      p.trialEndsAt
        ? `${p.firmName} now has ${PRODUCT_NAME}. The firm's free month runs until ${day(p.trialEndsAt)}. After that it is ${formatUsd(SEAT_PRICE_CENTS)} per user per month, and you subscribe on the website when you are ready.`
        : `${p.firmName} now has ${PRODUCT_NAME}. The free month is given once per person, and you have had yours with another firm, so this firm starts locked: subscribe on the Billing page (${formatUsd(SEAT_PRICE_CENTS)} per user per month, charged when you subscribe) to open it.`,
      `The next step is to add the ${PRODUCT_NAME} connector to Claude. The Connect page walks through it for Claude (Free, Pro and Max plans, and Team and Enterprise plans) and for ChatGPT.`,
      { label: "Connect page", url: p.connectUrl, fallback: `Connect page: open ${PRODUCT_NAME}, then Connect.` },
      ...(p.connectorUrl ? [`The connector address to paste into Claude is ${p.connectorUrl}.`] : []),
      `On the Firm page, enter the firm's letterhead details and attorneys, fill in the practice profile, invite your staff, and turn case work on for the connector when the firm wants it.`,
      billingLink(p.billingUrl),
    ]),

  trial_reminder_7d: (p) =>
    compose(`${PRODUCT_NAME}: your free month ends on ${day(p.trialEndsAt)}`, [
      `Hello,`,
      `The free month for ${p.firmName} ends on ${day(p.trialEndsAt)}. To keep using ${PRODUCT_NAME} and the connector in Claude after that, subscribe on the Billing page: ${monthly(p.seats)}, charged when the free month ends and then monthly. The subscription renews automatically and receipts come by email.`,
      `If you do not subscribe, the app and the connector lock when the free month ends. Nothing is deleted, and subscribing later unlocks the firm.`,
      billingLink(p.billingUrl),
    ]),

  trial_reminder_1d: (p) =>
    compose(`${PRODUCT_NAME}: your free month ends tomorrow`, [
      `Hello,`,
      `The free month for ${p.firmName} ends on ${day(p.trialEndsAt)}, which is tomorrow. Subscribe today on the Billing page to keep the app and the connector working: ${monthly(p.seats)}, renewed automatically, receipts by email.`,
      `If you do not subscribe, the firm is locked when the free month ends. Nothing is deleted, and subscribing later unlocks it.`,
      billingLink(p.billingUrl),
    ]),

  trial_ended: (p) =>
    compose(`${PRODUCT_NAME}: your free month has ended`, [
      `Hello,`,
      `The free month for ${p.firmName} ended on ${day(p.trialEndsAt)}, and the firm has no subscription, so the app and the connector in Claude are locked. Your matters, documents and settings are kept.`,
      `To unlock the firm, subscribe on the Billing page: ${formatUsd(SEAT_PRICE_CENTS)} per user per month, renewed automatically, receipts by email.`,
      billingLink(p.billingUrl, "Subscribe"),
    ]),

  payment_failed: (p) =>
    compose(`${PRODUCT_NAME}: a payment for ${p.firmName} failed`, [
      `Hello,`,
      `A payment for ${p.firmName}'s ${PRODUCT_NAME} subscription${p.amountCents !== null ? ` (${formatUsd(p.amountCents)})` : ""} did not go through. Stripe will retry it, and the firm keeps full access during a grace period that ends on ${day(p.graceEndsAt)}.`,
      `To update the card, open the Billing page and choose Manage billing. If the payment has not succeeded by the end of the grace period, the app and the connector lock until it does.`,
      billingLink(p.billingUrl, "Manage billing"),
      ...(p.invoiceUrl ? [{ label: "The invoice", url: p.invoiceUrl, fallback: "" }] : []),
    ]),

  subscription_confirmed: (p) =>
    compose(`${PRODUCT_NAME}: subscription confirmed for ${p.firmName}`, [
      `Hello,`,
      `Thank you. ${p.firmName} is subscribed to ${PRODUCT_NAME}: ${monthly(p.seats)}.`,
      p.firstChargeAt
        ? `The first charge is on ${day(p.firstChargeAt)}, when the free month ends. After that the subscription renews every month on its own, and a receipt comes by email after each payment.`
        : `The subscription renews every month on its own, and a receipt comes by email after each payment.`,
      `The seat count follows the firm's members: adding a member adds a seat and removing one removes it, prorated by Stripe. Cards, invoices and cancellation are under Manage billing on the Billing page.`,
      billingLink(p.billingUrl),
    ]),

  payment_receipt: (p) =>
    compose(`${PRODUCT_NAME}: receipt for ${p.firmName}${p.invoiceNumber ? ` (invoice ${p.invoiceNumber})` : ""}`, [
      `Hello,`,
      `${PRODUCT_NAME} received a payment of ${formatUsd(p.amountCents)} ${p.currency.toUpperCase()} for ${p.firmName}.`,
      [
        p.periodStart && p.periodEnd ? `Billing period: ${day(p.periodStart)} to ${day(p.periodEnd)}.` : "",
        p.seats !== null ? `Seats: ${p.seats} ${p.seats === 1 ? "user" : "users"}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      { label: "Invoice and receipt", url: p.invoiceUrl, fallback: "The invoice is under Manage billing on the Billing page." },
      billingLink(p.billingUrl),
    ].filter((para) => para !== "")),

  renewal_upcoming: (p) =>
    compose(`${PRODUCT_NAME}: your next payment is on ${day(p.renewsAt)}`, [
      `Hello,`,
      `${p.firmName}'s ${PRODUCT_NAME} subscription renews on ${day(p.renewsAt)}: ${monthly(p.seats)}, charged to the card on file. Nothing to do if that is right.`,
      `To change the card or cancel, open the Billing page and choose Manage billing before that date. The seat count follows the firm's members.`,
      billingLink(p.billingUrl),
    ]),

  cancel_reminder: (p) =>
    compose(`${PRODUCT_NAME}: ${p.firmName}'s subscription ends on ${day(p.endsAt)}`, [
      `Hello,`,
      `${p.firmName}'s ${PRODUCT_NAME} subscription is set to end on ${day(p.endsAt)}. When it ends, the app and the connector in Claude lock; matters, documents and settings are kept.`,
      `To keep the firm's access, open the Billing page, choose Manage billing, and renew the subscription before that date.`,
      billingLink(p.billingUrl, "Renew"),
    ]),

  lapsed_reminder: (p) =>
    compose(`${PRODUCT_NAME}: ${p.firmName} is locked`, [
      `Hello,`,
      `${p.firmName}'s ${PRODUCT_NAME} subscription ended${p.sequence === 1 ? "" : ` on ${day(p.lockedAt)}`}, so the app and the connector in Claude are locked. Your matters, documents and settings are kept.`,
      `To unlock the firm, subscribe again on the Billing page: ${formatUsd(SEAT_PRICE_CENTS)} per user per month, renewed automatically, receipts by email.`,
      billingLink(p.billingUrl, "Subscribe"),
      ...(p.sequence >= 3 ? [`This is the last reminder about this.`] : []),
    ]),
};

export function renderEmail<K extends EmailKind>(kind: K, params: EmailParams[K]): RenderedEmail {
  return RENDERERS[kind](params);
}

export function isEmailKind(value: unknown): value is EmailKind {
  return typeof value === "string" && value in RENDERERS;
}
