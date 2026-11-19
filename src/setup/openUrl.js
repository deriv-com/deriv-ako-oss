// Opens a URL in the default browser. Failure is silent: the setup prints the
// GitHub links it opens, and for the Slack app page explains how to create the
// app from manifests/ instead. Set BROWSER=none to never open one.

import { spawn } from "node:child_process";

/**
 * The program that opens a URL on each platform. None of them runs through a
 * shell, so `&` and other characters in a URL reach the browser intact. (On
 * Windows, `cmd /c start` would cut a URL at its first `&`.)
 */
export function openCommand(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export function openUrl(url) {
  if (process.env.BROWSER === "none") return;
  const [command, args] = openCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available.
  }
}
