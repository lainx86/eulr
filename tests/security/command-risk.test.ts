import { describe, expect, it } from "vitest";

import {
  analyzeCommandRisk,
  isHighRiskCommand,
} from "../../src/permissions/command-risk.js";

describe("command risk analysis", () => {
  it.each([
    "rm -rf /",
    "sudo rm --recursive --force $HOME",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown -h now",
    "systemctl reboot",
    "git reset --hard HEAD",
    "git clean -fdx",
    "git push origin main --force",
    "git push --force-with-lease origin main",
    ":(){ :|:& };:",
    "sh -c 'rm -rf /'",
    "rm -rf /tmp/..",
    "rm -rf /./",
    'rm -rf "$HOME/./"',
    "bash -lc 'rm -rf /tmp/..'",
    "busybox rm -rf /",
    "busybox sh -lc 'rm -rf /'",
    "sudo env busybox rm -rf /",
    "command -- busybox rm -rf /",
    "sudo --user root rm -rf /",
    "env -u UNUSED sh -lc 'rm -rf /'",
    "printf image > /dev/sda",
    "printf image >>'/dev/disk/by-id/example'",
    "git push origin +main",
    "git push origin +HEAD:refs/heads/main",
    "cat .env",
    "sh -lc 'cat credentials.json'",
    "busybox cat .env.local",
    "node < auth.json",
  ])("classifies %s as high risk", (command) => {
    expect(isHighRiskCommand(command)).toBe(true);
    expect(analyzeCommandRisk(command).reason).toBeTruthy();
  });

  it.each([
    "rm build/output.txt",
    "rm -rf ./dist",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git push origin feature",
    "printf 'git reset --hard is risky'",
    "echo /dev/sda",
    "printf '%s' '>/dev/sda'",
    "echo .env",
    "busybox echo .env",
    "git push origin refs/heads/main:refs/heads/main",
    "rm -rf /tmp/cache/..",
    "pnpm test",
  ])("does not flag the normal command %s", (command) => {
    expect(analyzeCommandRisk(command)).toEqual({ level: "normal" });
  });
});
