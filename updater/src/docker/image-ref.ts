export type ImageRef = {
  registry: string;
  repository: string;
  tag: string;
  digest: string | null;
};

const DOCKER_HUB = "registry-1.docker.io";

export function parseImageRef(ref: string): ImageRef {
  const at = ref.indexOf("@");
  const digest = at === -1 ? null : ref.slice(at + 1);
  const rest = at === -1 ? ref : ref.slice(0, at);

  const colon = rest.lastIndexOf(":");
  const hasTag = colon > rest.lastIndexOf("/");
  const tag = hasTag ? rest.slice(colon + 1) : "latest";
  const name = hasTag ? rest.slice(0, colon) : rest;

  const slash = name.indexOf("/");
  const first = slash === -1 ? "" : name.slice(0, slash);
  const hasHost = first !== "" && (first.includes(".") || first.includes(":") || first === "localhost");

  const host = hasHost ? first : "docker.io";
  const path = hasHost ? name.slice(slash + 1) : name;
  const registry = host === "docker.io" || host === "index.docker.io" ? DOCKER_HUB : host;
  const repository = registry === DOCKER_HUB && !path.includes("/") ? `library/${path}` : path;

  return { registry, repository, tag, digest };
}
