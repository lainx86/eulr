import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface EulrPaths {
  home: string;
  authFile: string;
  configFile: string;
  sessionsDir: string;
}

export function getEulrPaths(home = process.env.EULR_HOME): EulrPaths {
  const root = resolve(home ?? join(homedir(), ".eulr"));
  return {
    home: root,
    authFile: join(root, "auth.json"),
    configFile: join(root, "config.json"),
    sessionsDir: join(root, "sessions"),
  };
}
