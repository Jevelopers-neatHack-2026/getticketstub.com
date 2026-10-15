import "server-only";

/**
 * A provider call that did not give a usable answer. `status` is the provider's HTTP status, or 0 when it could not be
 * reached at all (a network failure or the timeout). Routes map every one of these to a 502 so the buyer is told
 * nothing was charged and a webhook is retried.
 */
export class PaymentError extends Error {
  constructor(
    readonly status: number,
    readonly provider: string,
  ) {
    super(status === 0 ? `${provider} could not be reached.` : `${provider} answered ${status}.`);
  }
}

/** One JSON call to a payment provider, with a 15-second timeout. Dodo and Stripe both go through here. */
export async function providerFetch<T>(provider: string, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    // fetch throws a TypeError on a network failure and a DOMException when the timeout fires
    throw new PaymentError(0, provider);
  }
  if (!res.ok) throw new PaymentError(res.status, provider);
  try {
    return (await res.json()) as T;
  } catch {
    throw new PaymentError(502, provider);
  }
}
