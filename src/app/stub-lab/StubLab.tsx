"use client";
// Stub lab: every SVG template, both faces, any sample event, screen or print.
//   /stub-lab                                  the catalogue grid
//   /stub-lab?t=premiere&face=front&data=concert&mode=screen&light=tilt&w=480
//                                              one stub alone (for screenshots); light = rest | tilt | <lx>,<ly>,<glow>
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type CSSProperties } from "react";
import { labBackground } from "./background";
import { SvgStub } from "@/customer/studio/stub/svg/SvgStub";
import { STUB_TEMPLATES, templateById } from "@/customer/studio/stub/svg/templates";
import { SAMPLES } from "@/customer/studio/stub/svg/samples";
import type { StubMode } from "@/customer/studio/stub/svg/render";

function lightVars(light: string): CSSProperties {
  const [lx, ly, glow] =
    light === "tilt" ? [78, 22, 0.95] : light === "rest" ? [38, 30, 0.1] : light.split(",").map(Number);
  return { ["--lx" as string]: `${lx}%`, ["--ly" as string]: `${ly}%`, ["--glow" as string]: String(glow) };
}

export function StubLab() {
  const q = useSearchParams();
  const t = q.get("t");
  if (t) {
    const meta = templateById(t);
    if (!meta) return <main><h1>Template not found</h1><p>Choose one of the design studies in the <a href="/stub-lab">stub lab</a>.</p></main>;
    const w = Math.max(120, Math.min(1600, Number(q.get("w")) || (meta.orientation === "landscape" ? 1100 : 480)));
    const h = meta ? (w * meta.height) / meta.width : w * 2;
    return (
      <main style={{ margin: 0, padding: 24, backgroundColor: labBackground(q.get("bg")), minHeight: "100vh", boxSizing: "border-box", ...lightVars(q.get("light") ?? "rest") }}>
        <div id="stub" style={{ width: w, height: h, filter: "drop-shadow(0 18px 30px rgb(0 0 0 / 0.45))" }}>
          <SvgStub
            template={t}
            face={q.get("face") === "back" ? "back" : "front"}
            data={SAMPLES[q.get("data") ?? "concert"] ?? SAMPLES.concert}
            mode={q.get("mode") === "print" ? "print" : "screen"}
            className="lab-stub"
            onReady={() => document.body.setAttribute("data-stub-ready", "1")}
          />
        </div>
        <style>{`.lab-stub{width:100%;height:100%}`}</style>
      </main>
    );
  }
  return <Catalogue />;
}

function Catalogue() {
  const [sample, setSample] = useState("concert");
  const [mode, setMode] = useState<StubMode>("screen");
  const [light, setLight] = useState({ lx: 38, ly: 30, glow: 0.1 });
  const vars = useMemo(() => lightVars(`${light.lx},${light.ly},${light.glow}`), [light]);
  return (
    <main
      style={{ padding: 24, background: "#141210", color: "#f3ece0", minHeight: "100vh", fontFamily: "var(--ts-font-ui)", ...vars }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setLight({ lx: ((e.clientX - r.left) / r.width) * 100, ly: ((e.clientY - r.top) / window.innerHeight) * 100, glow: 0.9 });
      }}
      onPointerLeave={() => setLight({ lx: 38, ly: 30, glow: 0.1 })}
    >
      <header style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 24 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Stub lab · {STUB_TEMPLATES.length} templates</h1>
        <p>Design studies with synthetic data. Not available for customer downloads, approval or ordering.</p>
        <select aria-label="Sample event" value={sample} onChange={(e) => setSample(e.target.value)}>
          {Object.keys(SAMPLES).map((k) => <option key={k}>{k}</option>)}
        </select>
        <select aria-label="Rendering mode" value={mode} onChange={(e) => setMode(e.target.value as StubMode)}>
          <option value="screen">screen</option>
          <option value="print">print</option>
        </select>
        <span style={{ opacity: 0.6, fontSize: 13 }}>Move the pointer to move the light.</span>
      </header>
      {STUB_TEMPLATES.map((m) => {
        const land = m.orientation === "landscape";
        const w = land ? 560 : 240;
        const h = (w * m.height) / m.width;
        return (
          <section key={m.id} style={{ marginBottom: 40 }}>
            <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>{m.name} <small style={{ opacity: 0.55 }}>· {m.direction} · {m.id}</small></h2>
            <p style={{ margin: "0 0 12px", opacity: 0.7, fontSize: 13 }}>{m.blurb}</p>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              {(["front", "back"] as const).map((face) => (
                <div key={face} style={{ width: w, height: h, filter: "drop-shadow(0 12px 22px rgb(0 0 0 / 0.5))" }}>
                  <SvgStub template={m.id} face={face} data={SAMPLES[sample]} mode={mode} className="lab-stub" />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <style>{`.lab-stub{width:100%;height:100%}`}</style>
    </main>
  );
}
