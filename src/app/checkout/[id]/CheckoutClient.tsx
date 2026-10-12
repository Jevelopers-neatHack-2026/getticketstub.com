"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MarkLegend, PaperButton, Rule, FinishSwatches, PunchTabs, SandboxStrip, SourceMark, Stamp, TearLink, type MarkKind } from "@/customer/desk/Desk";
import { StubView } from "@/customer/studio/stub/StubView";
import { MaterialFrame } from "@/customer/studio/editor/MaterialFrame";
import { VariantNote, pickFinish, pickMaterial } from "@/customer/studio/editor/MaterialPicker";
import { haptic } from "@/customer/studio/feedback";
import { getStub, upsertStub } from "@/customer/studio/store";
import { MATERIALS, formatMoney, type Material, type Stub } from "@/customer/studio/types";
import { PageShell, EmptyState, OnDesk, StampLink, ui } from "@/customer/pages/ui";
import { formatDate } from "@/customer/pages/share";
import { AfterPay, ReceiptField, useReceiptEmail } from "@/customer/account/Receipt";
import { useOrderFlow } from "@/customer/account/useOrderFlow";
import { FINISHES, SANDBOX_LABEL, cartItemFromStub, finishMarks, finishPrices, gateFor, quote, sizesFor, defaultSize, type PrintSize } from "@/customer/pages/commerce";
import { CAPABILITY_VERSION, HOLO_WORDS, SIZE_COPY, statusMark } from "@/customer/pages/capabilities";
import { addToCartAndFly } from "@/customer/cart/cartStore";
import { useMounted, nowMs } from "@/customer/pages/useMounted";
import { flow, major, variantId } from "@/customer/flows/events";
import s from "./checkout.module.css";

const MATERIAL_OPTIONS = MATERIALS.map((m) => ({ value: m.id, label: m.label, sub: formatMoney(m.priceMinor) }));

/** A size is a tab ("Classic stub") with what its number measures beneath ("2 × 5.5 in trim"). */
const sizeOption = (sz: PrintSize) => ({ value: sz, label: SIZE_COPY[sz].name, sub: SIZE_COPY[sz].measure });

export default function CheckoutClient({ id }: { id: string }) {
  const mounted = useMounted();
  const [stub, setStub] = useState<Stub | null | undefined>(undefined);
  const [size, setSize] = useState<PrintSize>("classic");
  const receipt = useReceiptEmail();
  const email = receipt.email;
  const [error, setError] = useState("");
  const [paid, setPaid] = useState(false);
  const { placed, progress, place: placeOrder, retry } = useOrderFlow();
  const [quoteAt, setQuoteAt] = useState(nowMs);
  const [now, setNow] = useState(nowMs);
  // The stub being priced: material and finish live on it, exactly as in the editor.
  const [draft, setDraft] = useState<Stub | null>(null);
  const deskRef = useRef<HTMLDivElement>(null);

  if (mounted && stub === undefined) {
    const st = getStub(id) ?? null;
    setStub(st);
    if (st) {
      setDraft(st);
      setSize(defaultSize(st));
    }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(nowMs()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Checkout began once the stub is found: once per visit, whatever re-renders or Strict Mode remounts do.
  const began = useRef(false);
  useEffect(() => {
    if (!stub || began.current) return;
    began.current = true;
    const qq = quote(stub.material, stub.finish, defaultSize(stub));
    flow("begin_checkout", { currency: "USD", value: major(qq.totalMinor), item_id: variantId(qq.material, qq.finish, qq.size), item_count: 1, context: "checkout", capability: "sandbox" });
  }, [stub]);

  const material = draft?.material ?? "print";
  const finish = draft?.finish ?? "foil";
  const q = useMemo(() => quote(material, finish, size), [material, finish, size]);
  const physical = material !== "digital";
  const expiresAt = quoteAt + 15 * 60_000;
  const minsLeft = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  const expired = minsLeft === 0;
  // the quote running out is reported when it happens (the 15 s clock), not on every render while it stays out
  useEffect(() => {
    if (expired && stub) flow("quote_expired", { context: "checkout" });
  }, [expired, stub]);
  const sizes = sizesFor(material);
  const finishLabel = FINISHES.find((f) => f.id === finish)?.label ?? finish;
  const materialLabel = MATERIALS.find((m) => m.id === material)?.label ?? material;

  // A preview can be quoted as a sandbox fixture; what the gate holds back (an unavailable finish, or a preview in live mode) can't be ordered.
  const gate = gateFor(material, finish, size);
  const mark = statusMark(q.variantStatus);
  const legend: MarkKind[] = ["estimated", ...(mark ? [mark] : [])];

  // Changing the material, finish or size is a different quote (its id names the choice and the capability version), so the clock restarts.
  function update(next: Stub, option: "material" | "finish") {
    flow("product_option", { option, material: next.material, finish: next.finish, context: "checkout" });
    setDraft(next);
    setSize((cur) => (sizesFor(next.material).includes(cur) ? cur : defaultSize(next)));
    setQuoteAt(nowMs());
    setError("");
  }

  if (!mounted || stub === undefined) return <PageShell back={{ href: "/wall", label: "Wall" }}>{null}</PageShell>;
  if (stub === null || !draft) {
    return (
      <PageShell back={{ href: "/wall", label: "Wall" }}>
        <EmptyState kind="stub" title="This stub isn't on this device." body="Stubs live on the device that made them. Open your wall and pick the one you want to print.">
          <StampLink href="/wall">Open your wall</StampLink>
        </EmptyState>
      </PageShell>
    );
  }

  function pay() {
    if (!stub || !draft || paid) return;
    if (!gate.ok) {
      flow("checkout_invalid", { reason: "variant_blocked" });
      setError(gate.message);
      return;
    }
    if (expired) {
      flow("checkout_invalid", { reason: "quote_expired" });
      setError("This quote has run out. Refresh it to see the current price.");
      return;
    }
    if (receipt.problem) {
      flow("checkout_invalid", { reason: "email" });
      setError(receipt.problem);
      document.getElementById("co-email")?.focus();
      return;
    }
    setPaid(true);
    // a sandbox card: nothing is charged. The order itself is reported by placeOrder once the server answers.
    flow("add_payment_info", { payment_type: "card", capability: "sandbox" });
    placeOrder({
      stubIds: [stub.id],
      lines: [{ title: stub.event.title, material, finish, size, totalMinor: q.totalMinor, variantStatus: q.variantStatus }],
      capabilityVersion: q.capabilityVersion,
      totalMinor: q.totalMinor,
      currency: q.currency,
      quoteId: q.quoteId,
      method: "card",
      email: email || undefined,
    }, () => upsertStub({ ...stub, material, finish, torn: true }));
    haptic([18, 40, 28]);
  }

  // Stays on the page: the stub flies to the cart button in the corner and the count stamps up.
  function toCart(from: Element | null) {
    if (!stub || !draft) return;
    if (!gate.ok) {
      flow("checkout_invalid", { reason: "variant_blocked" });
      setError(gate.message);
      return;
    }
    addToCartAndFly(cartItemFromStub(draft, material, finish, size), draft, deskRef.current ?? from, "checkout");
  }

  const e = stub.event;
  const when = [formatDate(e.dateISO), e.venue].filter(Boolean).join(" · ");

  return (
    <PageShell back={{ href: `/studio/${stub.id}`, label: "Back to your stub" }}>
      <SandboxStrip>{SANDBOX_LABEL}</SandboxStrip>
      <div className={s.layout}>
        <div className={s.desk} ref={deskRef}>
          <OnDesk>
            <MaterialFrame material={material} finish={finish}>
              <StubView stub={draft} size="md" tilt />
            </MaterialFrame>
          </OnDesk>
          <p className={s.cap}>
            <span className={s.capTitle}>{e.title}</span>
            {when ? <span className={s.capMeta}>{when}</span> : null}
          </p>
        </div>

        <section className={s.sheet} aria-labelledby="co-h">
          <header className={s.head}>
            <p className="desk-label">Checkout</p>
            <h1 id="co-h" className={s.title}>
              {physical ? "Put it on paper." : "Keep it forever."}
            </h1>
          </header>

          <div className={s.group}>
            <span className="desk-label">Material</span>
            <PunchTabs label="Material" options={MATERIAL_OPTIONS} value={material} onChange={(m: Material) => update(pickMaterial(draft, m), "material")} />
          </div>

          <div className={s.group}>
            <span className="desk-label">Finish</span>
            <FinishSwatches value={finish} prices={finishPrices(material)} marks={finishMarks(material, size)} onChange={(f) => update(pickFinish(draft, f), "finish")} />
            <VariantNote material={material} finish={finish} size={size} withSize={false} />
          </div>

          <div className={s.group}>
            <span className="desk-label">Size</span>
            {sizes.length > 1 ? (
              <PunchTabs
                label="Size"
                options={sizes.map(sizeOption)}
                value={size}
                onChange={(v) => {
                  flow("product_option", { option: "size", material, finish, size: v, context: "checkout" });
                  setSize(v);
                  setQuoteAt(nowMs());
                  setError("");
                }}
              />
            ) : (
              <p className={s.sizeLine}>
                <span>{sizeOption(size).label}</span>
                <span className={s.sizeSub}>{sizeOption(size).sub}</span>
              </p>
            )}
            <p className={ui.status}>{SIZE_COPY[size].caption}</p>
          </div>

          <Rule kind="perf" />

          <dl className={s.receipt}>
            <div className={s.line}>
              <dt>{materialLabel}</dt>
              <dd>{formatMoney(q.itemMinor)}</dd>
            </div>
            <div className={s.line}>
              <dt>{finish === "holo" && physical ? HOLO_WORDS : `${finishLabel} finish`}</dt>
              <dd>{finish === "holo" && physical ? "Not printed" : q.finishMinor ? formatMoney(q.finishMinor) : "Included"}</dd>
            </div>
            {physical ? (
              <div className={s.line}>
                <dt>Shipping</dt>
                <dd>
                  {formatMoney(q.shippingMinor)}
                  <SourceMark p="estimated" />
                </dd>
              </div>
            ) : null}
            <div className={`${s.line} ${s.total}`}>
              <dt>Total</dt>
              <dd>{formatMoney(q.totalMinor)}</dd>
            </div>
          </dl>
          <div className={s.quote}>
            {expired ? (
              <>
                <span data-announce>This quote has run out.</span>
                <TearLink
                  type="button"
                  onClick={() => {
                    flow("quote_refresh", { context: "checkout" });
                    setQuoteAt(nowMs());
                    setError("");
                  }}
                >
                  Refresh the quote
                </TearLink>
              </>
            ) : (
              <span>
                Quote holds for {minsLeft} min
                <SourceMark p="estimated" />. A quote is not a charge. Prices are sandbox fixtures, not printer quotes · capability map {CAPABILITY_VERSION}.
              </span>
            )}
          </div>

          {paid ? null : <ReceiptField id="co-email" r={receipt} error={receipt.problem && error === receipt.problem ? error : ""} onChange={() => setError("")} />}

          <div className={s.actions}>
            {paid ? (
              <div className={s.done}>
                <AfterPay placed={placed} email={email} signedIn={receipt.signedIn} progress={progress} onRetry={retry} />
              </div>
            ) : (
              <Stamp block onClick={pay} disabled={!gate.ok}>
                Pay {formatMoney(q.totalMinor)}
              </Stamp>
            )}
            {!gate.ok && !paid ? (
              <p className={ui.err} data-announce>
                {gate.message}
              </p>
            ) : error && error !== receipt.problem ? (
              <p className={ui.err} data-announce>
                {error}
              </p>
            ) : null}
            <PaperButton type="button" block onClick={(e) => toCart(e.currentTarget)} disabled={paid || !gate.ok}>
              Add to cart
            </PaperButton>
          </div>

          <MarkLegend marks={legend} />
        </section>
      </div>
    </PageShell>
  );
}
