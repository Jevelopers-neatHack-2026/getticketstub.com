"use client";
// Renders one face of an SVG stub template, filled with StubData. Foil and holo layers read the
// --lx --ly --glow variables that useTilt writes on an ancestor, so the light moves with the tilt.
import { useEffect, useId, useRef, useState } from "react";
import { stubFontsHref, type StubData } from "./contract";
import { layoutStub, loadTemplate, prepareStub, type StubMode } from "./render";

let fontsLinked: Promise<void> | null = null;
/** Adds the template fonts stylesheet once; resolves when its @font-face rules exist, so layout can load them. */
function linkFonts(): Promise<void> {
  if (fontsLinked) return fontsLinked;
  fontsLinked = new Promise<void>((resolve) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = stubFontsHref();
    l.onload = () => resolve();
    l.onerror = () => resolve();
    document.head.appendChild(l);
  });
  return fontsLinked;
}

export interface SvgStubProps {
  template: string;
  face?: "front" | "back";
  data: StubData;
  mode?: StubMode;
  className?: string;
  /** Called with the finished <svg> once text has been fitted (for export). */
  onReady?: (svg: SVGSVGElement) => void;
}

export function SvgStub({ template, face = "front", data, mode = "screen", className, onReady }: SvgStubProps) {
  const host = useRef<HTMLDivElement>(null);
  const uid = `s${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [error, setError] = useState<string | null>(null);
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  useEffect(() => {
    let live = true;
    Promise.all([loadTemplate(template, face), linkFonts()])
      .then(async ([text]) => {
        if (!live || !host.current) return;
        const svg = prepareStub(text, data, { uid: `${uid}${face}`, mode });
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.display = "block";
        host.current.replaceChildren(svg);
        await layoutStub(svg);
        if (live) {
          setError(null);
          ready.current?.(svg);
        }
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [template, face, data, mode, uid]);

  return (
    <div ref={host} className={className} data-stub-template={template} data-face={face}>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
