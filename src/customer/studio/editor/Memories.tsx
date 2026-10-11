"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { Stub } from "../types";
import { LeavesMark } from "@/customer/pages/ui";
import { PaperButton } from "@/customer/desk/Desk";
import { readImageFile } from "./ops";
import { flow } from "@/customer/flows/events";
import styles from "./overlays.module.css";

interface Props {
  stub: Stub;
  onChange: (s: Stub) => void;
}

/** What goes on the back and the memory page: event content, the note, friends and photos. */
export function Memories({ stub, onChange }: Props) {
  const ev = stub.event;
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const noteAtFocus = useRef("");

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      const added = await Promise.all(Array.from(files).slice(0, 6).map((f) => readImageFile(f, 900)));
      onChange({ ...stub, photos: [...stub.photos, ...added] });
      flow("photo_add", { via: "memories", result: "success", photo_count: stub.photos.length + added.length });
    } catch (e) {
      flow("photo_add", { via: "memories", result: "error", photo_count: stub.photos.length });
      setError(e instanceof Error ? e.message : "We couldn't read that photo. Try another one.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className={styles.stack}>
      {ev.setlist && ev.setlist.length > 0 && (
        <div>
          <p className="desk-label">Setlist</p>
          <p>
            {ev.setlist.length} songs
            {ev.setlist.some((s) => s.starred) && <> · ★ {ev.setlist.find((s) => s.starred)?.title}</>}
          </p>
        </div>
      )}
      {ev.score && (
        <div>
          <p className="desk-label">Final score</p>
          <p className={styles.num}>
            {ev.score.home} {ev.score.homeScore} – {ev.score.awayScore} {ev.score.away}
          </p>
          <p className={styles.muted}>{ev.score.moments.length} key moments</p>
        </div>
      )}
      {ev.cast && ev.cast.length > 0 && (
        <div>
          <p className="desk-label">Cast</p>
          <p>{ev.cast.map((c) => c.name).join(", ")}</p>
        </div>
      )}
      {ev.programme && ev.programme.length > 0 && (
        <div>
          <p className="desk-label">Programme</p>
          <ul className={styles.plainList}>
            {ev.programme.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <label className={styles.field}>
        <span className="desk-label">Note on the back</span>
        <textarea
          rows={2}
          maxLength={140}
          value={stub.personal.note ?? ""}
          placeholder="Who you were with, what you'll remember"
          onChange={(e) => onChange({ ...stub, personal: { ...stub.personal, note: e.target.value } })}
          // the note is saved on every key (as before) but reported once, when the person leaves the field: whether there is one, never what it says
          onFocus={(e) => (noteAtFocus.current = e.currentTarget.value)}
          onBlur={(e) => {
            if (e.currentTarget.value !== noteAtFocus.current) flow("note_edit", { has_note: e.currentTarget.value.trim().length > 0 });
          }}
        />
      </label>

      <div>
        <p className="desk-label">Friends</p>
        {stub.personal.friends.length > 0 ? (
          <p>
            {stub.personal.friends.map((f) => f.name).join(", ")} · {stub.personal.friends.filter((f) => f.claimed).length} claimed
          </p>
        ) : (
          <p className={styles.muted}>Send a matching stub to the people you went with.</p>
        )}
        <Link className={styles.textLink} href={`/friends/${stub.id}`}>
          {stub.personal.friends.length ? "Manage matching stubs" : "Send matching stubs to friends"}
          <LeavesMark />
        </Link>
      </div>

      <div>
        <p className="desk-label">Photos</p>
        {stub.photos.length > 0 && (
          <div className={styles.photoRow}>
            {stub.photos.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt={`Photo ${i + 1}`} className={styles.photoThumb} />
            ))}
          </div>
        )}
        <PaperButton onClick={() => fileRef.current?.click()}>Add photos</PaperButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Choose photos"
          onChange={(e) => addPhotos(e.target.files)}
        />
        {error && (
          <p className={styles.muted} data-announce>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
