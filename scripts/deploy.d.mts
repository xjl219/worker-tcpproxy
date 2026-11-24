export function validateUuid(value: string): string;
export function parseSecretNames(output: string): Set<string>;
export function resolveDeploymentUuid(input: {
  configuredUuid: string | undefined;
  secretNames: Set<string>;
}): { action: "set"; uuid: string } | { action: "reuse"; uuid: null };
