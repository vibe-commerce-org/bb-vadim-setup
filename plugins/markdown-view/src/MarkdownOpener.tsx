// The opener: the document in Vditor (read-only until "Редактировать"), BB's
// own preview on request. Where the file sits on disk is resolved once
// (`LocatedFile`): the document reads and writes it there, and relative links
// resolve from it.
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { CopyPathButton } from "./CopyPathButton";
import { Editor } from "./Editor";
import { LocatedFile } from "./LocatedFile";
import { RepoShell } from "./RepoShell";

/**
 * `repoTools` adds the repository tree and "Копировать путь" around the
 * document. Off by default: Explorer_vibecom embeds this opener in a panel
 * that already has a tree of its own, and asks for `copyPath` alone.
 */
export function MarkdownOpener({
  repoTools = false,
  copyPath = false,
  ...props
}: PluginFileOpenerProps & { repoTools?: boolean; copyPath?: boolean }) {
  return (
    <LocatedFile {...props} loadingLabel="Открываю Markdown…">
      {(file, showOriginal) =>
        repoTools ? (
          <RepoShell key={file.path} file={file} onOriginal={showOriginal} />
        ) : (
          <Editor
            file={file}
            onOriginal={showOriginal}
            leading={copyPath ? (compact) => <CopyPathButton path={file.path} compact={compact} /> : undefined}
          />
        )
      }
    </LocatedFile>
  );
}
