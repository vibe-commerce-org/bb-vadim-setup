// Every hue of the palette is readable in both themes: WCAG AA, 4.5:1 for
// small text. Reads the oklch() values from app.css, so the test and the
// stylesheet cannot drift apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HUES } from "../lib/labels.ts";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

function oklchOf(block: string, property: "color" | "background"): [number, number] {
  const match = new RegExp(`\\n\\s*${property}: oklch\\(([\\d.]+) ([\\d.]+) var\\(--vbrt-h`).exec(block);
  assert.ok(match, property);
  return [Number(match[1]), Number(match[2])];
}

// OKLCH → linear sRGB (Björn Ottosson), clipped to the sRGB gamut.
function linearSrgb(l: number, c: number, hueDegrees: number): [number, number, number] {
  const h = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(text: [number, number], background: [number, number], hue: number): number {
  const one = luminance(linearSrgb(text[0], text[1], hue));
  const two = luminance(linearSrgb(background[0], background[1], hue));
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

for (const [theme, selector] of [
  ["light", ".vbrt-tag"],
  ["dark", ".dark .vbrt-tag"],
] as const) {
  test(`${theme} theme: every hue reaches 4.5:1`, () => {
    const block = rule(selector);
    const text = oklchOf(block, "color");
    const background = oklchOf(block, "background");
    for (const hue of HUES) {
      const ratio = contrast(text, background, hue);
      assert.ok(ratio >= 4.5, `hue ${hue}: ${ratio.toFixed(2)}`);
    }
  });
}
