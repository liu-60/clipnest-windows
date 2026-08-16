import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const projectId = process.argv[2];
const projectsFile = resolve(process.env.PROJECTS_FILE || "/var/lib/clipnest-cloud/projects.json");

if (!projectId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId)) {
  console.error("usage: node create-project.mjs <project-id>");
  process.exit(2);
}

const projects = existsSync(projectsFile)
  ? JSON.parse(readFileSync(projectsFile, "utf8"))
  : {};
if (projects[projectId] && process.argv[3] !== "--rotate") {
  console.error("project already exists; use --rotate to issue a new token");
  process.exit(3);
}

const token = randomBytes(32).toString("base64url");
projects[projectId] = {
  tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
  createdAt: new Date().toISOString(),
};
mkdirSync(dirname(projectsFile), { recursive: true, mode: 0o700 });
writeFileSync(projectsFile, `${JSON.stringify(projects, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`PROJECT_ID=${projectId}`);
console.log(`PROJECT_TOKEN=${token}`);
