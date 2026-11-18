import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fullscreen wheel-scroll speed fix.
 *
 * Why: in fullscreen TUI mode pi owns the viewport and the wheel scrolls
 * `wheelScrollLines` lines per mouse event (hardcoded to 1 since 0.84.0,
 * see pi issue #7765). Windows Terminal only sends ONE wheel event per
 * notch and ignores the system "lines to scroll" setting in mouse mode
 * (microsoft/terminal#18102), so one notch = one line. This extension
 * lifts the step to `lines` (default 3, like pi < 0.84.0).
 *
 * Usage: /wheel <lines>   e.g. /wheel 5
 */

const DEFAULT_LINES = 3;

export default function (pi: ExtensionAPI) {
  let lines = DEFAULT_LINES;
  let currentTui: any = null;

  const apply = () => {
    // `currentTui` is a stable reference that always points at the live
    // renderer, so re-applying on every render also survives runtime TUI
    // mode switches (`/settings`). Regular mode has no such property,
    // hence the guard.
    if (currentTui && "wheelScrollLines" in currentTui) {
      currentTui.wheelScrollLines = Math.max(1, Math.floor(lines));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("wheel-scroll-speed", (tui: any) => {
      currentTui = tui;
      apply();
      return {
        render: () => {
          apply(); // keep it sticky across renderer swaps
          return [] as string[];
        },
        invalidate: () => {},
      };
    });
  });

  pi.registerCommand("wheel", {
    description: `Set fullscreen wheel scroll speed in lines per notch (default ${DEFAULT_LINES}); usage: /wheel <n>`,
    handler: async (args, ctx) => {
      const n = parseInt((args ?? "").trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 100) {
        ctx.ui.notify(`Usage: /wheel <lines> - currently ${lines}`, "info");
        return;
      }
      lines = n;
      apply();
      ctx.ui.notify(`Mouse wheel now scrolls ${lines} line(s) per notch`, "info");
    },
  });
}
