"use client";
// Placing an order with honest progress: the local record lands first, then the server is told. `placed` is
// null while the request is out (see `progress` for sending, "Still working..." and unknown), and carries a
// `code` when the response could not confirm it; `retry` sends the same attempt again (no second local copy).
import { useRef, useState } from "react";
import { useProgress } from "@/customer/feedback-messages/progress";
import { goToCheckout, isPayable, newAttemptId, placeOrder, resendOrder, type Placed } from "./orders";

export function useOrderFlow() {
  const { state, run } = useProgress();
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [held, setHeld] = useState<Placed | null>(null);

  // What the caller does once the order is placed (empty the cart, tear the stub). Never run for a checkout that is
  // still to be paid: the buyer may come back from the provider with nothing bought. For an order that could be paid
  // for it runs only on success, so any error keeps the cart; a sandbox-only order keeps its local record either way.
  const afterPlaced = useRef<(() => void) | undefined>(undefined);
  const payable = useRef(false);
  // One id per checkout attempt, kept until the order is placed, so a double press or a retry can't start a second checkout.
  const attempt = useRef<string | undefined>(undefined);

  function settle(p: Placed | undefined) {
    if (!p) return;
    // The server started a provider checkout: payment happens on the provider's page, which returns to /payment/return.
    if (goToCheckout(p)) return;
    if (!p.code || !payable.current) {
      afterPlaced.current?.();
      afterPlaced.current = undefined;
    }
    // A closed checkout can't be retried: the next press starts a fresh attempt.
    if (!p.code || p.code === "checkout_closed") attempt.current = undefined;
    setHeld(p);
    setPlaced(p);
  }
  function place(draft: Parameters<typeof placeOrder>[0], onPlaced?: () => void) {
    afterPlaced.current = onPlaced;
    payable.current = isPayable(draft);
    attempt.current ??= newAttemptId();
    const attemptId = attempt.current;
    setPlaced(null);
    void run(() => placeOrder(draft, attemptId)).then(settle);
  }
  const retry = held?.code
    ? () => {
        setPlaced(null);
        void run(() => resendOrder(held)).then(settle);
      }
    : undefined;
  return { placed, progress: state, place, retry };
}
