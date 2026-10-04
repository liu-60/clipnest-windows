import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Derives the helper's stable opaque profile binding from Electron's selected userData path. */
export function createNativeHelperEnvironment(
  userDataPath: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!isAbsolute(userDataPath)) throw new Error("native_profile_path_invalid");
  const stableProfileId = createHash("sha256")
    .update(resolve(userDataPath).toLowerCase(), "utf8")
    .digest("hex");
  return { ...inheritedEnvironment, CLIPNEST_STABLE_PROFILE_ID: stableProfileId };
}
