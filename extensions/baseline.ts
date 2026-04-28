import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Baseline extension used to verify this package is loaded.
 * Keep this lightweight; add real extensions as separate files or folders.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus("personal-ext", "personal extensions loaded");

    if (event.reason === "startup" || event.reason === "reload") {
      ctx.ui.notify("Personal Pi extensions loaded", "info");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("personal-ext", undefined);
  });

  pi.registerCommand("personal-ext", {
    description: "Show status for the personal Pi extension package",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Personal Pi extension package is active.", "info");
    },
  });
}
