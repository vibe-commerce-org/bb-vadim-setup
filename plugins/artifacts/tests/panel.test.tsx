import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { ArtifactsPanel } from "../app";
import type { Artifact, RpcContract } from "../rpc";

const THREAD = "thr_abcdef";
const fileArtifact: Artifact = {
  id: "art_file", threadId: THREAD, title: "План", kind: "plan", icon: "ListChecks", description: "План MVP",
  target: { kind: "workspace-file", path: "backlog/plans/mvp.md" }, sortOrder: 0, pinned: true, archived: false, createdAt: 1, updatedAt: 1,
};

describe("ArtifactsPanel SDK contract", () => {
  it("loads the current thread, opens a file through BB, and keeps controls labelled", async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, target: { kind: "workspace" as const, environmentId: "env_1", path: "backlog/plans/mvp.md" } }));
    const slot = renderSlot<PluginThreadPanelProps, RpcContract>({ component: ArtifactsPanel }, { threadId: THREAD, params: null }, {
      rpc: {
        list: async () => ({ artifacts: [fileArtifact] }),
        resolve,
        state: async () => ({ artifact: fileArtifact }),
        add: async () => ({ artifact: fileArtifact }),
        update: async () => ({ artifact: fileArtifact }),
        remove: async () => ({ ok: true as const }),
        suggest: async () => ({ suggestions: [] }),
      },
      openFilePreview: () => true,
    });
    await waitFor(() => expect(screen.getByText("План")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Открыть План" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Открыть План" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ threadId: THREAD, id: "art_file" }));
    expect(slot.inspection.navigateCalls.some((call) => call.method === "experimental_openFilePreview")).toBe(true);
    slot.lifecycle.unmount();
  });
});
