// "Копировать путь": the full path of the file on screen to the clipboard.
// The word shows beside the icon in a wide panel; in a narrow one the icon
// alone, which turns into a tick for a moment once the path is copied.
import { useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard";
import { CheckIcon, CopyIcon } from "./icons";
import { ICON_BUTTON, TOOL_BUTTON, ToolText } from "./ui";

const COPIED_MS = 1500;

export function CopyPathButton({ path, compact }: { path: string; compact: boolean }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(path);
    setCopied(ok ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };

  return (
    <button
      type="button"
      className={compact ? ICON_BUTTON : TOOL_BUTTON}
      title={`Скопировать полный путь: ${path}`}
      aria-label="Копировать полный путь к файлу"
      onClick={() => void copy()}
    >
      {copied === "ok" ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite" className={compact ? "sr-only" : ""}>
        {copied === "ok" ? "Скопировано" : copied === "fail" ? "Не удалось скопировать" : "Копировать путь"}
      </span>
    </button>
  );
}
