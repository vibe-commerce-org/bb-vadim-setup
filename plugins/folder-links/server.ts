// bb-plugin-folder-links — backend entry.
//
// Reads the disk of the machine BB's server runs on, and only inside the home
// folder — in WSL2 also inside the Windows user's profile folder, and inside
// the folders of the projects BB has open on this machine, wherever they lie:
// whether an exact path from a chat link is a folder (or, for a missing one,
// which folder up the same path exists), and one level of a folder for the
// tree. Never writes, never searches by name.
import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./rpc";
import { cachedFor } from "./src/cache";
import { extraRoots, inspectPath, listFolder } from "./src/folders";
import { profileLookup, windowsProfile } from "./src/wsl";

const PROJECTS_TTL_MS = 10_000;

export default function plugin(bb: BbPluginApi): void {
  const home = homedir();
  const findProfile = profileLookup(() => windowsProfile());
  // Start the lookup now: PowerShell takes a moment, and the first click should not wait for it.
  void findProfile();
  /** Folders of the projects BB has open on this machine; a new project is picked up within seconds. */
  const projectFolders = cachedFor(
    async () => {
      const [{ primaryHostId }, projects] = await Promise.all([bb.sdk.system.config(), bb.sdk.projects.list()]);
      if (primaryHostId === null) return [];
      return projects.flatMap((project) =>
        project.sources.filter((source) => source.hostId === primaryHostId).map((source) => source.path),
      );
    },
    PROJECTS_TTL_MS,
    [],
  );
  /** The home folder, in WSL2 the Windows profile folder, and the folders of BB's projects here. */
  const roots = async (): Promise<string[]> => {
    const [profile, projects] = await Promise.all([findProfile(), projectFolders()]);
    const base = profile === null ? [home] : [home, profile];
    return [...base, ...extraRoots(projects, base)];
  };

  bb.rpc.register(rpcContract, {
    async inspect({ paths }) {
      const unique = [...new Set(paths)];
      const allowed = await roots();
      return { results: await Promise.all(unique.map(async (path) => ({ path, ...(await inspectPath(path, allowed)) }))) };
    },

    async list({ path }) {
      const listing = await listFolder(path, await roots());
      if (!listing.ok) return listing;
      const { primaryHostId } = await bb.sdk.system.config();
      return { ...listing, hostId: primaryHostId };
    },
  });
}
