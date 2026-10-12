import type { EventData, Fact } from "../types";

// Brand art prompt (brand-kit/docs/imagery.md): text-free painterly scene, research facts as
// constraints with their opposites as negatives, one Ticket Orange accent, empty dark top third.

const ORANGE = "Ticket Orange #E4572E";

function factText(event: EventData, id: string): string | undefined {
  // API callers can have older or partially saved event records without a facts array.
  const facts = Array.isArray(event?.facts) ? event.facts : [];
  const f: Fact | undefined = facts.find((x) => x && typeof x === "object" && x.id === id);
  if (!f) return undefined;
  const label = typeof f.label === "string" ? f.label : "";
  const value = typeof f.value === "string" ? f.value : "";
  return `${label} ${value}`.toLowerCase();
}

function weatherClause(event: EventData): { weather: string; negatives: string[] } {
  const w = factText(event, "weather");
  if (!w) return { weather: "", negatives: [] };
  const negatives: string[] = [];
  let weather = "";
  if (/snow/.test(w)) {
    weather = "snowy";
    negatives.push("rain", "summer heat", "green leaves");
  } else if (/rain|drizzle|shower/.test(w)) {
    weather = "rainy, wet reflective streets,";
    negatives.push("snow", "clear blue sky", "harsh sunshine", "dry dusty ground");
  } else if (/dry|clear|sun/.test(w)) {
    weather = "dry, clear air,";
    negatives.push("rain", "puddles", "umbrellas open against rain", "snow");
  }
  const t = w.match(/(-?\d+)\s*°c/);
  if (t) {
    const c = Number(t[1]);
    if (c <= 5) {
      weather = `cold ${weather}`;
      negatives.push("summer clothing", "bare arms");
    } else if (c >= 22) {
      weather = `warm ${weather}`;
      negatives.push("winter coats", "snow", "frost");
    }
  }
  return { weather: weather.trim(), negatives };
}

function seasonFromDate(dateISO?: string): string {
  if (!dateISO) return "";
  const m = Number(dateISO.slice(5, 7));
  if (!m) return "";
  if (m === 12 || m <= 2) return "winter";
  if (m <= 5) return "spring";
  if (m <= 8) return "summer";
  return "autumn";
}

function sceneFor(event: EventData): { place: string; accent: string; light: string } {
  switch (event.type) {
    case "concert":
      return { place: "the street outside a small concert hall, warm stage glow spilling from the doors", accent: `a ${ORANGE} umbrella`, light: "sodium streetlamps and stage-door neon" };
    case "game":
      return { place: "the approach to a football ground, floodlight towers above the terraces", accent: `a ${ORANGE} scarf`, light: "stadium floodlights cutting through the air" };
    case "show":
      return { place: "a theatre facade with a glowing marquee canopy (no lettering)", accent: `a ${ORANGE} coat`, light: "marquee bulbs and warm foyer light" };
    default:
      return { place: "a gathering place lit late into the night, laptops and lamps glowing through tall windows", accent: `a ${ORANGE} lamp`, light: "warm desk lamps and screen glow" };
  }
}

/** Build the image prompt for an event. `vibe` is a remix chip or free text ("moodier", "sunrise"). */
export function buildArtPrompt(event: EventData, vibe?: string): string {
  const { weather, negatives } = weatherClause(event);
  const season = seasonFromDate(typeof event.dateISO === "string" ? event.dateISO : undefined);
  const scene = sceneFor(event);
  const city = typeof event.city === "string" && event.city.toLowerCase() !== "online" ? ` in ${event.city}` : "";
  const venue = typeof event.venue === "string" && event.venue ? `, inspired by the architecture of ${event.venue} (described, not copied)` : "";
  const mood = vibe?.trim() ? ` Mood: ${vibe.trim()}.` : "";

  const lines = [
    `Illustration only, no text, no letters: ${[weather, season, "evening"].filter(Boolean).join(" ")}${city}, ${scene.place}${venue},`,
    `${scene.light}, lone figure with ${scene.accent} as the only saturated element, everything else muted (ink, cream, copper, faded cyan),`,
    `painterly vintage travel-poster style, vertical 2:3 composition with an empty dark sky in the top third for type.${mood}`,
    `Avoid: text, letters, typography, logos, signage lettering, trademarks, real likenesses, crowds with hands up, more than one orange object${negatives.length ? ", " + negatives.join(", ") : ""}.`,
  ];
  return lines.join("\n");
}
