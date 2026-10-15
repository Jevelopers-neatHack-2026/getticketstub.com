import "server-only";
import type { Order } from "@/customer/pages/commerce";
import { formatMoney } from "@/customer/studio/types";

// "Paper stub" email: cream paper, a wordmark, a picture of the stub, two short lines, one stamped
// orange button. Tables and inline CSS only, so Gmail, Apple Mail and Outlook all draw it the same.
// Colours are the brand-kit tokens: cream #F4ECDD, ink #17140F, orange #E4572E, copper #B4693E, muted #625D55.
// Voice (brand-kit docs/voice.md): benefit first, buttons are verbs, short, no exclamation marks.

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

const CREAM = "#F4ECDD";
const INK = "#17140F";
const ORANGE = "#E4572E";
const COPPER = "#B4693E";
const MUTED = "#625D55";
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The stub picture: our own rendered card for a share token, or the generic brand card. Absolute, from the app origin. */
export const stubImageUrl = (origin: string, shareToken?: string | null) => `${origin}/api/stub-image/${shareToken || "brand"}`;

interface Paper {
  preheader: string;
  lines: readonly string[];
  imageUrl: string;
  imageAlt: string;
  button: { label: string; url: string };
  /** Extra HTML between the copy and the button (the receipt's line items). */
  middle?: string;
  small: string;
}

function legalOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "https://getticketstub.com";
  }
}

/** One plain line at the foot of every email: where the privacy note and terms live. */
const legalText = (url: string) => `Privacy: ${legalOrigin(url)}/privacy\nTerms: ${legalOrigin(url)}/terms`;

function paper(p: Paper): string {
  const origin = legalOrigin(p.button.url);
  const copy = p.lines
    .map((l) => `<tr><td style="padding:0 0 10px 0;font-family:${SERIF};font-size:18px;line-height:26px;color:${INK}">${esc(l)}</td></tr>`)
    .join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>TicketStub</title></head>` +
    `<body style="margin:0;padding:0;background-color:${CREAM}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM}">${esc(p.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background-color:${CREAM}"><tr><td align="center" style="padding:28px 12px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">` +
    // wordmark
    `<tr><td align="left" style="padding:0 0 18px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="14" height="14" bgcolor="${ORANGE}" style="width:14px;height:14px;background-color:${ORANGE};font-size:0;line-height:0">&nbsp;</td>` +
    `<td style="padding-left:10px;font-family:${SANS};font-size:15px;font-weight:700;letter-spacing:3px;color:${INK}">TICKETSTUB</td></tr></table></td></tr>` +
    // the stub
    `<tr><td style="border:1px dashed ${COPPER};padding:0" bgcolor="${CREAM}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:18px 18px 8px 18px">` +
    `<img src="${esc(p.imageUrl)}" width="480" alt="${esc(p.imageAlt)}" style="display:block;width:100%;max-width:480px;height:auto;border:0;outline:none;text-decoration:none;background-color:${CREAM}">` +
    `</td></tr><tr><td style="padding:14px 28px 6px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${copy}</table>${p.middle ?? ""}</td></tr>` +
    // stamped button: padding lives on the cell, since Outlook ignores it on links
    `<tr><td align="left" style="padding:10px 28px 30px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td align="center" bgcolor="${ORANGE}" style="background-color:${ORANGE};border:2px solid ${INK};border-radius:6px;box-shadow:3px 3px 0 ${INK}">` +
    `<a href="${esc(p.button.url)}" target="_blank" style="display:block;padding:14px 30px;font-family:${SANS};font-size:16px;font-weight:700;letter-spacing:.5px;color:${INK};text-decoration:none">${esc(p.button.label)}</a>` +
    `</td></tr></table></td></tr></table></td></tr>` +
    // fine print
    `<tr><td style="padding:18px 6px 0 6px;font-family:${SANS};font-size:12px;line-height:18px;color:${MUTED}">${esc(p.small)}<br>` +
    `Button not working? Paste this into your browser:<br><a href="${esc(p.button.url)}" style="color:${MUTED};word-break:break-all">${esc(p.button.url)}</a></td></tr>` +
    `<tr><td style="padding:12px 6px 0 6px;font-family:${SANS};font-size:12px;line-height:18px;color:${MUTED}">` +
    `<a href="${esc(origin)}/privacy" style="color:${MUTED}">Privacy</a> &middot; <a href="${esc(origin)}/terms" style="color:${MUTED}">Terms</a></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

const LINK_COPY = {
  save: { subject: "Your link to save your wall", lines: ["Open this link and your stubs are saved to your wall.", "It works once and expires in 15 minutes."], button: "Open your wall" },
  checkout: { subject: "Your link to finish your order", lines: ["Open this link to sign in and finish printing your stub.", "It works once and expires in 15 minutes."], button: "Sign in" },
  claim: { subject: "Your link to claim your stub", lines: ["Open this link to sign in and add your stub to your wall.", "It works once and expires in 15 minutes."], button: "Sign in" },
} as const;

export type LinkReason = keyof typeof LINK_COPY;

const IGNORE = "Didn't ask for this? Ignore this email. Nothing happens until someone opens the link.";

export function magicLinkMail(reason: LinkReason, url: string, imageUrl: string): Mail {
  const c = LINK_COPY[reason];
  return {
    subject: c.subject,
    text: `${c.lines.join(" ")}\n\n${c.button}: ${url}\n\n${IGNORE}\n\nTicketStub\n${legalText(url)}`,
    html: paper({ preheader: c.lines[0], lines: c.lines, imageUrl, imageAlt: "Your TicketStub", button: { label: c.button, url }, small: IGNORE }),
  };
}

export function emailChangeMail(url: string, imageUrl: string): Mail {
  const lines = ["Open this link to make this your TicketStub email.", "It works once and expires in 15 minutes."];
  return {
    subject: "Confirm your new TicketStub email",
    text: `${lines.join(" ")}\n\nConfirm your email: ${url}\n\n${IGNORE}\n\nTicketStub\n${legalText(url)}`,
    html: paper({ preheader: lines[0], lines, imageUrl, imageAlt: "Your TicketStub", button: { label: "Confirm your email", url }, small: IGNORE }),
  };
}

const SIZE: Record<string, string> = { classic: "Classic stub", stamp: "Stamp", framed: "Framed print", file: "Digital file" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function receiptMail(order: Order, wallUrl: string, imageUrl: string): Mail {
  const currency = order.currency ?? "USD";
  const lines = order.lines.map((l) => ({
    label: `${l.title} · ${cap(l.material)} · ${cap(l.finish)} · ${SIZE[l.size] ?? l.size}`,
    price: formatMoney(l.totalMinor, currency),
  }));
  // A confirmed payment prints what the provider actually charged, tax included.
  const charged = order.payment?.status === "paid" ? order.payment.chargedMinor : undefined;
  const tax = charged !== undefined && charged > order.totalMinor ? charged - order.totalMinor : 0;
  const total = formatMoney(charged ?? order.totalMinor, currency);
  // Only a webhook-confirmed payment changes this line. A test-mode payment charges nothing real.
  const paid = order.payment?.status === "paid";
  const sandbox = !paid ? "Sandbox, nothing was charged." : order.payment?.environment === "test_mode" ? "Paid in test mode, no real charge." : "Paid.";
  const copy = ["Your order is in. Here's what you ordered.", sandbox];
  const rows = lines
    .map((l) => `<tr><td style="padding:6px 0;font-family:${SANS};font-size:14px;line-height:20px;color:${INK};border-bottom:1px solid ${COPPER}">${esc(l.label)}</td><td align="right" style="padding:6px 0 6px 12px;font-family:${SANS};font-size:14px;color:${INK};white-space:nowrap;border-bottom:1px solid ${COPPER}">${esc(l.price)}</td></tr>`)
    .join("");
  const taxRow = tax ? `<tr><td style="padding:6px 0;font-family:${SANS};font-size:14px;line-height:20px;color:${INK};border-bottom:1px solid ${COPPER}">Tax</td><td align="right" style="padding:6px 0 6px 12px;font-family:${SANS};font-size:14px;color:${INK};white-space:nowrap;border-bottom:1px solid ${COPPER}">${esc(formatMoney(tax, currency))}</td></tr>` : "";
  const middle =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px 0">${rows}${taxRow}` +
    `<tr><td style="padding:10px 0 0 0;font-family:${SANS};font-size:15px;font-weight:700;color:${INK}">Total</td><td align="right" style="padding:10px 0 0 12px;font-family:${SANS};font-size:15px;font-weight:700;color:${INK}">${esc(total)}</td></tr></table>`;
  return {
    subject: "Your TicketStub receipt",
    text:
      `${copy[0]}\n\n` +
      lines.map((l) => `${l.label}: ${l.price}`).join("\n") +
      (tax ? `\nTax: ${formatMoney(tax, currency)}` : "") +
      `\n\nTotal: ${total}\n${sandbox}\nOrder ${order.id}\n\nOpen your wall: ${wallUrl}\n\nTicketStub\n${legalText(wallUrl)}`,
    html: paper({ preheader: `${copy[0]} ${total}.`, lines: copy, imageUrl, imageAlt: "Your stub", button: { label: "Open your wall", url: wallUrl }, middle, small: `Order ${order.id}` }),
  };
}
