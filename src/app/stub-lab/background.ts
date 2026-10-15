/** The lab query may select only a literal color, never CSS images, URLs or variables. */
export function labBackground(value: string | null): string {
  if (value === "transparent") return value;
  if (value && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)) return value;
  return "#1a1a1a";
}
