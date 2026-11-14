/**
 * Credential and internal paths stay off the project interface.
 * Matching is case-insensitive and applies to every path segment.
 */
const reservedExact = new Set([
  ".git", ".ssh", ".cache", ".scratch", ".aws", ".azure", ".kube", ".gnupg", ".npm", ".terraform",
  ".envrc", ".npmrc", ".pypirc", ".netrc", "_netrc", ".pgpass", ".htpasswd", ".git-credentials", "git-credentials",
  ".kubeconfig", "kubeconfig", "auth.json", "application_default_credentials.json", "authorized_keys",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  ".vault-token", ".s3cfg", ".boto", ".my.cnf", ".terraformrc", "rclone.conf", "settings-security.xml"
]);
const credentialExtensions = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "p8", "ppk", "gpg"]);
const backupSuffix = /^(?:bak|backup|old|orig|tmp|temp|swp|save|copy|\d{1,4})$/;

function reservedSegment(part: string): boolean {
  const name = part.toLowerCase();
  if (!name || name === "." || name === "..") return false;
  if (reservedExact.has(name)) return true;
  if (/^\.zigent(?:-.*)?$/.test(name)) return true;
  if (!/\.env\.(?:example|sample|template)$/.test(name) && (name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name.includes(".env."))) return true;
  if (name.endsWith(".tfstate") || name.includes(".tfstate.")) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$/.test(name)) return true;
  if (/^(?:.*[._-])?kubeconfig(?:\..*)?$/.test(name)) return true;
  if (/credentials/.test(name) && /\.(?:json|ya?ml|toml|ini|xml|cfg|conf)$/.test(name)) return true;
  if (/^secrets?\.(?:json|ya?ml|toml|ini|xml|cfg|conf)$/.test(name)) return true;
  if (/service-?account/.test(name) && name.endsWith(".json")) return true;
  const pieces = name.split(".").filter(Boolean);
  const last = pieces.at(-1) ?? "";
  const previous = pieces.at(-2) ?? "";
  if (credentialExtensions.has(last)) return true;
  if (pieces.length >= 2 && backupSuffix.test(last) && credentialExtensions.has(previous)) return true;
  return false;
}

export function reservedProjectPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some(reservedSegment)) return true;
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index]!.toLowerCase();
    const child = parts[index + 1]?.toLowerCase();
    if (name === ".docker" && parts.slice(index + 1).some(part => part.toLowerCase() === "config.json")) return true;
    if (name === ".config" && child === "gcloud") return true;
    if (name === ".config" && child === "gh" && parts.slice(index + 2).some(part => part.toLowerCase() === "hosts.yml")) return true;
    if (name === ".config" && child === "rclone") return true;
    if (name === ".m2" && (child === "settings.xml" || child === "settings-security.xml")) return true;
    if (name === ".gradle" && child === "gradle.properties") return true;
  }
  return false;
}
