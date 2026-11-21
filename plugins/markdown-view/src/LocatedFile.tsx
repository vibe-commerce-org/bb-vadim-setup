// What every opener of this package does first: find where the file sits on
// disk (resolved once — the view reads it there, and relative links resolve
// from it), say so when BB left the source incomplete, and switch to BB's own
// preview on request.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { locateFile } from "./file-access";
import type { FileLocation } from "./file-access";
import { BUTTON, Loading, Notice, ScrollFrame, sourceKey, useLatest } from "./ui";

type Located =
  | { status: "locating" }
  | { status: "found"; file: FileLocation }
  | { status: "no-source" }
  | { status: "error"; message: string };

/** `children` draws the found file; `showOriginal` swaps it for BB's own preview. */
export function LocatedFile({
  path,
  source,
  Original,
  loadingLabel,
  children,
}: PluginFileOpenerProps & {
  loadingLabel: string;
  children: (file: FileLocation, showOriginal: () => void) => ReactNode;
}) {
  const sdk = useLatest(useSdk());
  const latestSource = useLatest(source);
  const key = sourceKey(source);
  const [original, setOriginal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [located, setLocated] = useState<Located>({ status: "locating" });

  useEffect(() => {
    const controller = new AbortController();
    // BB may hand this same opener another file: "Стандартный просмотр" was a choice for the previous one.
    setOriginal(false);
    setLocated({ status: "locating" });
    locateFile(sdk.current, path, latestSource.current, controller.signal).then(
      (file) => {
        if (!controller.signal.aborted) setLocated(file === null ? { status: "no-source" } : { status: "found", file });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLocated({
          status: "error",
          message: `Не удалось найти файл: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
    return () => controller.abort();
  }, [sdk, latestSource, path, key, attempt]);

  const showOriginal = () => setOriginal(true);
  if (original) {
    return (
      <ScrollFrame>
        <Original />
      </ScrollFrame>
    );
  }
  if (located.status === "locating") return <Loading label={loadingLabel} />;
  if (located.status === "no-source") {
    return (
      <Notice message="BB не сообщил, откуда открыт этот файл.">
        <button type="button" className={BUTTON} onClick={showOriginal}>
          Стандартный просмотр
        </button>
      </Notice>
    );
  }
  if (located.status === "error") {
    return (
      <Notice message={located.message}>
        <button type="button" className={BUTTON} onClick={() => setAttempt((n) => n + 1)}>
          Повторить
        </button>
        <button type="button" className={BUTTON} onClick={showOriginal}>
          Стандартный просмотр
        </button>
      </Notice>
    );
  }
  return children(located.file, showOriginal);
}
