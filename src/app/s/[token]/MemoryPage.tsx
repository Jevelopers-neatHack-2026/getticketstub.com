"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "@/customer/a11y/focus";
import { api } from "@/customer/account/api";
import { messageForError } from "@/customer/feedback-messages/messages";
import { sharePath } from "@/customer/account/share";
import d from "@/customer/desk/Desk.module.css";
import { MarkLegend, PaperButton, Rule, SourceMark, Stamp, Stamped, Tool, Tools } from "@/customer/desk/Desk";
import { FlipIcon } from "@/customer/desk/icons";
import { StubView } from "@/customer/studio/stub/StubView";
import { play, haptic } from "@/customer/studio/feedback";
import { decodeStub, getStub, upsertStub } from "@/customer/studio/store";
import { formatMoney, type Stub } from "@/customer/studio/types";
import { FINISHES, materialPrice } from "@/customer/pages/commerce";
import { PageShell, FriendlyError, OnDesk, PaperLink, StampLink, TearAnchor, ui } from "@/customer/pages/ui";
import { TearLink } from "@/customer/desk/Desk";
import { absoluteUrl, formatDate, isStub, shareLink } from "@/customer/pages/share";
import { errorCode, flow } from "@/customer/flows/events";
import { DownloadStub } from "@/customer/studio/download/DownloadStub";
import { renderStoryPng, downloadBlob, photoToDataUrl } from "@/customer/pages/storyImage";
import { useMounted } from "@/customer/pages/useMounted";
import { EventContent, Facts } from "./EventContent";
import s from "./memory.module.css";

/** What printing costs: the stock plus the finish add-on, the same sum checkout shows. */
function printMinor(st: Stub): number {
  const physical = st.material !== "digital";
  return materialPrice(st.material) + (physical ? (FINISHES.find((f) => f.id === st.finish)?.upchargeMinor ?? 0) : 0);
}

export default function MemoryPage({ token, gift, giftTo, giftToken, wrap = true }: { token: string; gift: boolean; giftTo?: string; giftToken?: string; wrap?: boolean }) {
  const mounted = useMounted();
  // A short token is a snapshot on the server; anything else (every older link) carries the stub itself.
  const [remote, setRemote] = useState<{ token: string; stub: Stub | null } | null>(null);
  useEffect(() => {
    if (!mounted) return;
    let live = true;
    api
      .sharedStub(token)
      .then((r) => live && setRemote({ token, stub: isStub(r.stub) ? r.stub : null }))
      .catch(() => live && setRemote({ token, stub: null }));
    return () => {
      live = false;
    };
  }, [mounted, token]);
  // A gift's own link: the message comes from the gift API and nowhere on the share. No valid token, no message.
  const [giftState, setGiftState] = useState<{ token: string; to: string; message: string } | null | undefined>(undefined);
  const [giftFor, setGiftFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!mounted || !giftToken) return;
    let live = true;
    api
      .gift(giftToken)
      .then((r) => live && (setGiftFor(giftToken), setGiftState({ token: giftToken, to: r.to, message: r.message })))
      .catch(() => live && (setGiftFor(giftToken), setGiftState(null)));
    return () => {
      live = false;
    };
  }, [mounted, giftToken]);
  const giftPending = !!giftToken && giftFor !== giftToken;
  const giftNote = giftToken && giftFor === giftToken && giftState?.token === giftToken ? giftState : null;
  const decoded = useMemo(() => {
    if (!mounted) return undefined;
    if (remote?.token === token && remote.stub) return remote.stub;
    if (remote?.token !== token) return undefined; // still asking the server
    const dec = decodeStub(token);
    return isStub(dec) ? dec : null;
  }, [mounted, token, remote]);
  const [ownedState, setOwnedState] = useState<{ id: string; stub?: Stub } | null>(null);
  if (decoded && ownedState?.id !== decoded.id) setOwnedState({ id: decoded.id, stub: getStub(decoded.id) });
  const owned = ownedState?.stub;
  const setOwned = (next: Stub) => setOwnedState({ id: next.id, stub: next });
  const [flipped, setFlipped] = useState(false);
  const [torn, setTorn] = useState(false);
  const giftRef = useRef<HTMLDivElement>(null);
  const wrapped = !torn && (gift || (!!giftNote && wrap));
  // the gift wrap is a dialog over the page: focus lands on "Tear it open" and stays until it is open
  useDialogFocus(giftRef, wrapped, "button");
  const [opening, setOpening] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok?: boolean }>({ text: "" });
  const [stampKey, setStampKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopped, setStopped] = useState(false);

  // The landing, once the link is read (server snapshot, encoded stub, or nothing): once per link, never its contents.
  const landed = useRef<string | null>(null);
  const settled = mounted && decoded !== undefined && !giftPending;
  useEffect(() => {
    if (!settled || landed.current === token) return;
    landed.current = token;
    const server = remote?.token === token && !!remote.stub;
    const owner = !!ownedState?.stub && server; // local ownership on this device, not an identity
    flow("share_landing", {
      surface: giftToken || gift ? "gift" : "memory",
      result: decoded ? "valid" : "invalid",
      viewer: owner ? "owner" : "visitor",
      link_kind: server ? "server" : "encoded",
    });
  }, [settled, token, decoded, remote, ownedState, giftToken, gift]);

  if (!mounted) return <PageShell>{null}</PageShell>;
  if (decoded === undefined || giftPending) return <PageShell>{null}</PageShell>;
  if (!decoded) {
    return (
      <PageShell>
        <FriendlyError title="We couldn't open this stub." body="The link may be cut short. Ask the sender for the link again, or make a stub of your own." />
      </PageShell>
    );
  }

  // A link that carries the stub itself (not a server token) is untrusted data: it can be read, never owned.
  const legacy = !(remote?.token === token && remote.stub);
  const stub = owned ?? decoded;
  const isOwner = !!owned && !legacy;
  const e = stub.event;
  const meta = [formatDate(e.dateISO), e.venue, e.city].filter(Boolean).join(" · ");
  const shareUrl = absoluteUrl(`/s/${token}`);
  const claimHref = `/claim/${encodeURIComponent(stub.setId ?? stub.id)}?from=${token}`;

  function say(text: string, ok = false) {
    setStatus({ text, ok });
    setStampKey((k) => k + 1);
  }

  function flip() {
    setFlipped((f) => !f);
    play("flip");
    haptic([10]);
  }

  async function share() {
    // The owner's link becomes a short server link when there is a server; everyone else re-shares the link they opened.
    const url = isOwner ? absoluteUrl(await sharePath(stub)) : shareUrl;
    const data = { title: `${e.title} · TicketStub`, text: "My stub from that night.", url };
    // closing the share sheet is a cancel (nothing more happens); another failure falls back to copying
    const outcome = await shareLink(data, "memory", "stub");
    if (outcome === "copied") say("Link copied", true);
    else if (outcome === "failed") say("Couldn't copy the link. Copy it from the address bar.");
  }

  async function stopSharing() {
    try {
      await api.stopSharing(stub.id);
      flow("stop_sharing_stub", { result: "saved" });
      setStopped(true);
      setConfirmStop(false);
      say("Sharing stopped. The old link no longer works.", true);
    } catch (err) {
      flow("stop_sharing_stub", { result: "error", error_code: errorCode(err) });
      say(messageForError(err).message);
    }
  }

  async function downloadStory() {
    setBusy(true);
    say("Building your story image…");
    const blob = await renderStoryPng(stub);
    setBusy(false);
    // the image was made and a download started; whether the file was kept is the browser's business
    flow("story_export", { action: "download", result: blob ? "generated" : "failed" });
    if (!blob) {
      say("We couldn't build the image. Try again, or take a screenshot of the preview.");
      return;
    }
    const slug = e.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "stub";
    downloadBlob(blob, `ticketstub-${slug}-story.png`);
    say("Story saved", true);
  }

  async function addPhotos(files: FileList | null) {
    if (!files || !owned) return;
    say("Adding photos…");
    const urls = (await Promise.all(Array.from(files).slice(0, 6).map((f) => photoToDataUrl(f)))).filter((u): u is string => !!u);
    const next = { ...owned, photos: [...owned.photos, ...urls].slice(-12) };
    upsertStub(next);
    flow("photo_add", { via: "memory_page", result: urls.length ? "success" : "error", photo_count: next.photos.length });
    setOwned(next);
    play("drop");
    if (urls.length) say(`${urls.length} ${urls.length === 1 ? "photo" : "photos"} added`, true);
    else say("We couldn't read those photos. Try a JPG or PNG.");
  }

  function removePhoto(i: number) {
    if (!owned) return;
    const next = { ...owned, photos: owned.photos.filter((_, j) => j !== i) };
    flow("memory_photo_remove", { photo_count: next.photos.length, storage: upsertStub(next) ? "ok" : "failed" });
    setOwned(next);
  }

  function tearOpen() {
    setOpening(true);
    play("tear");
    haptic([4, 30, 4, 30, 18]);
    setTimeout(() => {
      setLeaving(true);
      play("drop");
      setTimeout(() => {
        setTorn(true);
        flow("gift_unwrap");
      }, 600);
    }, 650);
  }

  const noPhotos = stub.photos.length === 0;

  return (
    <>
      <PageShell>
        <div className={s.layout} inert={wrapped}>
          <div className={s.desk}>
            <OnDesk>
              <button type="button" className={s.stubBtn} onClick={flip} aria-label={flipped ? "Show the front of the stub" : "Flip the stub to the back"}>
                <StubView stub={stub} size="lg" tilt flipped={flipped} />
              </button>
            </OnDesk>
            <div className={s.toolsRow}>
              <Tools label="Stub">
                <Tool icon={<FlipIcon />} active={flipped} onClick={() => setFlipped((f) => !f)}>
                  {flipped ? "Front" : "Back"}
                </Tool>
              </Tools>
            </div>
            {isOwner ? (
              <div className={s.actions}>
                <Stamp block onClick={share}>
                  Share your stub
                </Stamp>
                <div className={s.actionsPair}>
                  <PaperLink href={`/checkout/${stub.id}`} onClick={() => flow("cta_select", { cta: "print", context: "memory" })}>
                    {stub.material === "digital" ? "Get the file" : "Print it"} · {formatMoney(printMinor(stub))}
                    <SourceMark p="sandbox" />
                  </PaperLink>
                  <PaperLink href={`/wallet/${stub.id}`} onClick={() => flow("cta_select", { cta: "wallet", context: "memory" })}>
                    Add to Wallet
                  </PaperLink>
                </div>
                <div className={s.tearHolder}>
                  <TearAnchor href={`/friends/${stub.id}`} onClick={() => flow("cta_select", { cta: "friends", context: "memory" })}>
                    Send matching stubs to friends
                  </TearAnchor>
                </div>
                <DownloadStub stub={stub} context="memory" hint={false} />
                <MarkLegend marks={["sandbox"]} />
              </div>
            ) : null}
            <div className={`${ui.status} ${s.status}`} data-announce>
              {status.ok ? <Stamped key={stampKey}>{status.text}</Stamped> : status.text}
            </div>
          </div>

          <article className={s.content}>
            <header className={s.titleBlock}>
              {e.subtitle ? <p className="desk-label">{e.subtitle}</p> : null}
              <h1 className={s.title}>{e.title}</h1>
              {meta ? <p className={s.meta}>{meta}</p> : null}
              {e.seat ? (
                <p className={s.seatLine}>
                  <span className="desk-label">Seat</span>
                  {e.seat}
                </p>
              ) : null}
            </header>

            <EventContent event={e} />
            <Facts facts={e.facts} />

            {stub.personal.friends.length > 0 ? (
              <section className={s.section} aria-labelledby="who-h">
                <header className={s.secHead}>
                  <h2 id="who-h" className={s.secTitle}>
                    Who was there
                  </h2>
                  <Rule kind="double" />
                </header>
                <ul className={s.friends}>
                  {stub.personal.friends.map((f, i) => (
                    <li key={`${f.name}-${i}`} className={s.friend}>
                      <span className={s.avatar} aria-hidden="true">
                        {f.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className={s.friendName}>
                        <strong>{f.name}</strong>
                        <span className={s.friendMeta}>{[f.seat, f.claimed ? "has their stub" : "seat not claimed yet"].filter(Boolean).join(" · ")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {giftNote ? (
              <section className={s.section} aria-labelledby="gift-note-h">
                <header className={s.secHead}>
                  <h2 id="gift-note-h" className={s.secTitle}>
                    {giftNote.to ? `A note for ${giftNote.to}` : "A note for you"}
                  </h2>
                  <Rule kind="double" />
                </header>
                {giftNote.message ? <p className={s.note}>{giftNote.message}</p> : <p className={ui.muted}>No note this time, just the stub.</p>}
              </section>
            ) : null}

            {stub.personal.note ? (
              <section className={s.section} aria-labelledby="note-h">
                <header className={s.secHead}>
                  <h2 id="note-h" className={s.secTitle}>
                    Note
                  </h2>
                  <Rule kind="double" />
                </header>
                <p className={s.note}>{stub.personal.note}</p>
              </section>
            ) : null}

            {isOwner || !noPhotos ? (
              <section className={s.section} aria-labelledby="photos-h">
                <header className={s.secHead}>
                  <h2 id="photos-h" className={s.secTitle}>
                    Photos
                  </h2>
                  <Rule kind="double" />
                </header>
                {!noPhotos ? (
                  <ul className={s.photos}>
                    {stub.photos.map((p, i) => (
                      <li key={i} className={s.photo}>
                        <div className={s.photoFrame}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p} alt={`Photo ${i + 1} from ${e.title}`} />
                        </div>
                        {isOwner ? (
                          <button type="button" className={d.tearLink} onClick={() => removePhoto(i)} aria-label={`Remove photo ${i + 1}`}>
                            Remove
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {isOwner ? (
                  <div className={s.emptyPhotos}>
                    <p className={ui.muted}>
                      {noPhotos ? "Add the photos from that night. They'll sit beside the stub." : "Photos stay on this device. They aren't in the share link."}
                    </p>
                    <label className={`${d.paper} ${s.filePick}`}>
                      {noPhotos ? "Add photos" : "Add more photos"}
                      <input type="file" accept="image/*" multiple onChange={(ev) => addPhotos(ev.currentTarget.files)} />
                    </label>
                    {noPhotos ? <p className={ui.status}>Photos stay on this device. They aren&apos;t in the share link.</p> : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {isOwner ? (
              <section className={s.section} aria-labelledby="share-h">
                <header className={s.secHead}>
                  <h2 id="share-h" className={s.secTitle}>
                    What your friends see
                  </h2>
                  <Rule kind="double" />
                </header>
                <p className={ui.muted}>Your stub as a still image and as a link preview. Anyone with the link can open this page.</p>
                <div className={s.previews}>
                  <figure className={s.previewFig}>
                    <div className={`desk-surface ${s.story}`} aria-hidden="true">
                      <StubView stub={stub} size="sm" />
                      <p className={s.storyTitle}>{e.title}</p>
                      <p className={s.storyMeta}>{meta}</p>
                      <p className={s.madeWith}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/brand/favicon.svg" alt="" width={16} height={16} /> Made with TicketStub
                      </p>
                    </div>
                    <figcaption>Story · 9:16</figcaption>
                  </figure>
                  <figure className={s.previewFig}>
                    <div className={s.og} aria-hidden="true">
                      <StubView stub={stub} size="sm" />
                      <div className={s.ogText}>
                        <p className={s.ogTitle}>{e.title}</p>
                        <p className={s.storyMeta}>{meta}</p>
                        <p className={s.madeWith}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/brand/favicon.svg" alt="" width={16} height={16} /> Made with TicketStub
                        </p>
                      </div>
                    </div>
                    <figcaption>Link preview · 1200 × 630</figcaption>
                  </figure>
                </div>
                <div className={ui.row}>
                  <PaperButton type="button" onClick={downloadStory} disabled={busy}>
                    Story image
                  </PaperButton>
                  {confirmStop ? (
                    <span role="group" aria-label="Stop sharing this stub">
                      <span className={ui.muted}>This link stops working for everyone who has it. </span>
                      <TearLink type="button" onClick={stopSharing}>
                        Stop sharing
                      </TearLink>{" "}
                      <TearLink type="button" onClick={() => setConfirmStop(false)}>
                        Keep sharing
                      </TearLink>
                    </span>
                  ) : stopped ? null : (
                    <TearLink type="button" onClick={() => setConfirmStop(true)}>
                      Stop sharing
                    </TearLink>
                  )}
                </div>
              </section>
            ) : null}

            {!isOwner ? (
              <section className={s.make} aria-labelledby="make-h">
                <Rule kind="perf" />
                <h2 id="make-h" className={s.makeHead}>
                  Your night deserves a stub too.
                </h2>
                <p className={ui.muted}>Paste your ticket and get a stub with the setlist, the weather and the story of the night.</p>
                <StampLink href="/" onClick={() => flow("cta_select", { cta: "make_own", context: "memory" })}>
                  Paste your ticket link
                </StampLink>
                {legacy ? null : (
                  <TearAnchor href={claimHref} onClick={() => flow("cta_select", { cta: "claim", context: "memory" })}>
                    Were you there too? Claim a matching stub
                  </TearAnchor>
                )}
              </section>
            ) : null}

            <p className={s.unlisted}>
              Anyone with the link can see this page. It isn&apos;t listed or searchable.
              {legacy ? " Old share link." : ""}
            </p>
          </article>
        </div>
      </PageShell>

      {wrapped ? (
        <div ref={giftRef} className={`desk-surface ${s.giftStage}`} data-leaving={leaving ? "" : undefined} role="dialog" aria-modal="true" aria-label="A gift for you">
          <div className={`${s.giftBox} ${opening ? s.giftOpening : ""}`}>
            <p className="desk-label">{giftNote?.to || giftTo ? `For ${giftNote?.to || giftTo}` : "A gift for you"}</p>
            <h1 className={s.giftTitle}>Someone made you a stub.</h1>
            <p className={s.giftSub}>{e.title}</p>
            {giftNote?.message ? <p className={s.giftNote}>{giftNote.message}</p> : null}
            <div className={s.giftWrapArt} aria-hidden="true">
              <span className={s.ribbonV} />
              <span className={s.ribbonH} />
            </div>
            <Stamp onClick={tearOpen} disabled={opening}>
              Tear it open
            </Stamp>
          </div>
        </div>
      ) : null}
    </>
  );
}
