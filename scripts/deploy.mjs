import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error("PROXY_UUID/UUID must be a canonical UUID");
  }
  return value.trim();
}

export function parseSecretNames(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Unable to parse Wrangler secret list output; refusing to rotate the proxy UUID");
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.secrets;
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected Wrangler secret list format; refusing to rotate the proxy UUID");
  }
  return new Set(entries.map((entry) => entry?.name).filter((name) => typeof name === "string"));
}

export function resolveDeploymentUuid({ configuredUuid, secretNames }) {
  if (configuredUuid !== undefined && configuredUuid !== "") {
    return { action: "set", uuid: validateUuid(configuredUuid) };
  }
  if (secretNames.has("UUID")) return { action: "reuse", uuid: null };
  return { action: "set", uuid: randomUUID() };
}

function runWrangler(args, input) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["wrangler", ...args], {
    encoding: "utf8",
    input,
    shell: process.platform === "win32",
    stdio: input === undefined ? ["inherit", "pipe", "inherit"] : ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler ${args[0]} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout ?? "";
}

async function main() {
  const configuredUuid = process.env.PROXY_UUID ?? process.env.UUID;
  let secretNames = new Set();

  if (configuredUuid === undefined || configuredUuid === "") {
    const output = runWrangler(["secret", "list", "--json"]);
    secretNames = parseSecretNames(output);
  }

  const decision = resolveDeploymentUuid({ configuredUuid, secretNames });
  if (decision.action === "set") {
    // Send the credential over stdin; never print it or write it into the repository.
    runWrangler(["secret", "put", "UUID"], decision.uuid + "\n");
    process.stdout.write(configuredUuid ? "Using supplied UUID secret.\n" : "Generated and stored a new UUID secret.\n");
  } else {
    process.stdout.write("Reusing the existing Cloudflare UUID secret.\n");
  }

  runWrangler(["deploy"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Secure deployment stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
