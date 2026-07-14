import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<boolean>;

export const openBrowser: BrowserOpener = async (url) => {
  const command = browserCommand(url);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    try {
      const child = spawn(command.executable, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
};

function browserCommand(url: string): { executable: string; args: string[] } {
  if (process.platform === "darwin") {
    return { executable: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return {
      executable: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { executable: "xdg-open", args: [url] };
}

export { browserCommand };
