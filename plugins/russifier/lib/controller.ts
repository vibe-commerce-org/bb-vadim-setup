// One controller per app window: which language is on, and the translator
// that applies it. Inputs:
// - the plugin setting `language` (ru | en), pushed by the settings bridge;
// - a per-device choice from the command «Язык интерфейса…», kept in
//   localStorage, so the phone and the Mac can differ;
// - the content script's lifetime (mount → start, abort → restore English).
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import type { Engine } from "./engine.ts";
import { DomTranslator } from "./dom.ts";
import { MissingLog } from "./missing.ts";

export type Lang = "ru" | "en";
const isLang = (value: unknown): value is Lang => value === "ru" || value === "en";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

class LanguageController {
  private translator: DomTranslator | null = null;
  private missing: MissingLog | null = null;
  private pluginId = "russifier";
  private serverLang: Lang | null = null;
  private collectMissing = true;

  private key(name: string): string {
    return `${this.pluginId}:${name}`;
  }

  private localChoice(): Lang | null {
    const value = storage()?.getItem(this.key("language"));
    return isLang(value) ? value : null;
  }

  /** Device choice, else the server setting, else its last known value, else Russian. */
  effective(): Lang {
    const cached = storage()?.getItem(this.key("server-language"));
    return this.localChoice() ?? this.serverLang ?? (isLang(cached) ? cached : "ru");
  }

  mount(ctx: PluginContentScriptContext, makeEngine: () => Engine): () => void {
    this.pluginId = ctx.pluginId;
    const missing = new MissingLog((items) => this.report(items));
    missing.enabled = this.collectMissing;
    const translator = new DomTranslator(document, makeEngine(), {
      onMissing: (text) => missing.add(text),
      warn: (message) => console.warn(`[${ctx.pluginId}] ${message}`),
    });
    this.translator = translator;
    this.missing = missing;
    (globalThis as { __russifier?: unknown }).__russifier = { stats: translator.stats, effective: () => this.effective() };
    this.apply();
    return () => {
      translator.stop();
      missing.stop();
      if (this.translator === translator) this.translator = null;
      if (this.missing === missing) this.missing = null;
    };
  }

  /** From the settings bridge: `useSettings().values`. */
  setServerSettings(values: Record<string, unknown>): void {
    if (isLang(values.language)) {
      this.serverLang = values.language;
      storage()?.setItem(this.key("server-language"), values.language);
    }
    if (typeof values.collectMissing === "boolean") {
      this.collectMissing = values.collectMissing;
      if (this.missing) this.missing.enabled = values.collectMissing;
    }
    this.apply();
  }

  /** Command palette: switch this device between Russian and English. */
  toggleLocal(): Lang {
    const next: Lang = this.effective() === "ru" ? "en" : "ru";
    const store = storage();
    if (next === (this.serverLang ?? "ru")) store?.removeItem(this.key("language"));
    else store?.setItem(this.key("language"), next);
    this.apply();
    return next;
  }

  private apply(): void {
    const translator = this.translator;
    if (!translator) return;
    if (this.effective() === "ru") {
      translator.start();
      this.missing?.start();
    } else {
      translator.stop();
      this.missing?.stop();
    }
  }

  private async report(items: { text: string; count: number }[]): Promise<void> {
    await fetch(`/api/v1/plugins/${encodeURIComponent(this.pluginId)}/rpc/missing.report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
      keepalive: true,
    });
  }
}

export const controller = new LanguageController();
