import { promises as fs, appendFileSync } from "fs";
import * as path from "path";

interface Dependency {
  modrinth?: {
    project_id: string;
    dependency_type: string;
  };
  curseforge?: {
    slug: string;
    projectID?: string;
    type: string;
  };
}

interface PublishConfig {
  version: string;
  versionType: string;
  name: string;
  changelog: string;
  files: string[];
  primaryFile: string;
  gameVersions: string[];
  loaders: string[];
  java: string;
  dependencies: Dependency[];
}

interface ReleaseAsset {
  id: number;
  name: string;
}

interface Release {
  id: number;
  html_url: string;
  upload_url: string;
  assets: ReleaseAsset[];
}

const USER_AGENT = "ehmc-publish-action/1.0.0";

function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (process.env[key] || "").trim();
}

function info(message: string): void {
  console.log(message);
}

function setSecret(value: string): void {
  if (!value) return;
  const escaped = value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::add-mask::${escaped}`);
}

function setOutput(name: string, value: string | number): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${name}<<EOF\n${value}\nEOF\n`);
    return;
  }
  console.log(`::set-output name=${name}::${value}`);
}

function getBooleanInput(name: string, fallback = false): boolean {
  const value = getInput(name).toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseDependencies(value: string): Dependency[] {
  const pattern =
    /^([^@\s{}]+)(?:@([^\s({}]+))?\(([^)]+)\)(?:\{modrinth:([^}]+)\})?(?:\{curseforge:([^}]+)\})?$/;
  const cfTypes: Record<string, string> = {
    required: "requiredDependency",
    optional: "optionalDependency",
    incompatible: "incompatible",
    embedded: "embeddedLibrary",
    tool: "tool",
    requiredDependency: "requiredDependency",
    optionalDependency: "optionalDependency",
    embeddedLibrary: "embeddedLibrary",
  };
  const mrTypes = new Set(["required", "optional", "incompatible", "embedded"]);

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = pattern.exec(line);
      if (!match) {
        throw new Error(`Could not parse dependency: ${line}`);
      }
      const [, slug, , rawType, modrinthId, curseforgeId] = match;
      const type = rawType.toLowerCase();
      const dependency: Dependency = {};
      if (modrinthId && mrTypes.has(type)) {
        dependency.modrinth = { project_id: modrinthId, dependency_type: type };
      }
      if (curseforgeId) {
        dependency.curseforge = {
          slug,
          projectID: curseforgeId,
          type: cfTypes[type] || "requiredDependency",
        };
      }
      return dependency;
    });
}

function contentTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jar" || ext === ".zip" || ext === ".mrpack") return "application/java-archive";
  if (ext === ".json") return "application/json";
  if (ext === ".txt" || ext === ".md") return "text/plain";
  return "application/octet-stream";
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasMagic(segment: string): boolean {
  return /[*?[]/.test(segment);
}

function baseForPattern(pattern: string): string {
  const segments = pattern.split("/");
  const prefix: string[] = [];
  for (const segment of segments) {
    if (hasMagic(segment)) break;
    prefix.push(segment);
  }
  return prefix.join("/") || ".";
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 2;
        if (pattern[index] === "/") {
          source += "(?:.*/)?";
          index += 1;
        } else {
          source += ".*";
        }
        index -= 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (/[\\^$.+()[\]{}|]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

async function walk(dir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, results);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
}

async function expandFiles(patternsInput: string): Promise<string[]> {
  const cwd = process.cwd();
  const matches = new Set<string>();

  for (const rawPattern of parseList(patternsInput)) {
    const pattern = normalizePath(rawPattern);
    const base = baseForPattern(pattern);
    const baseDir = path.resolve(cwd, base);
    const regex = globToRegExp(pattern);
    const candidates: string[] = [];
    await walk(baseDir, candidates);
    for (const candidate of candidates) {
      const relative = normalizePath(path.relative(cwd, candidate));
      if (regex.test(relative)) {
        matches.add(path.resolve(cwd, relative));
      }
    }
  }

  const files = [...matches].sort();
  if (files.length === 0) throw new Error("files matched no files");
  return files;
}

async function loadConfig(): Promise<PublishConfig> {
  const version = getInput("version");
  if (!version) throw new Error("version is required");

  const filesInput = getInput("files");
  if (!filesInput) throw new Error("files is required");

  const files = await expandFiles(filesInput);
  const primaryInput = getInput("primary-file");
  let primaryFile = files[0];
  if (primaryInput) {
    const match = files.find(
      (file) =>
        file === primaryInput ||
        file === path.resolve(primaryInput) ||
        path.basename(file) === primaryInput,
    );
    if (!match) throw new Error(`primary-file did not match any file: ${primaryInput}`);
    primaryFile = match;
  }

  let changelog = getInput("changelog");
  const changelogFile = getInput("changelog-file");
  if (!changelog && changelogFile) {
    changelog = await fs.readFile(changelogFile, "utf8");
  }

  return {
    version,
    versionType: getInput("version-type") || "release",
    name: getInput("name") || version,
    changelog,
    files,
    primaryFile,
    gameVersions: parseList(getInput("game-versions")),
    loaders: parseList(getInput("loaders") || "fabric"),
    java: getInput("java"),
    dependencies: parseDependencies(getInput("dependencies")),
  };
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${label} failed (${response.status}): ${text}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text}`);
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": USER_AGENT,
  };
}

async function publishGithub(config: PublishConfig): Promise<void> {
  const token = getInput("github-token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    info("Skipping GitHub Releases: no github-token");
    return;
  }
  setSecret(token);

  const repoInput = getInput("github-repository") || process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repoInput.split("/");
  if (!owner || !repo) throw new Error("github-repository must be owner/repo");

  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const tag = getInput("github-tag") || `v${config.version}`;
  const generateNotes = getBooleanInput("github-generate-notes");
  const draft = getBooleanInput("github-draft");
  const prerelease = getBooleanInput("github-prerelease");
  const headers = githubHeaders(token);

  let release: Release;
  try {
    const created = await fetch(`${apiUrl}/repos/${owner}/${repo}/releases`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tag_name: tag,
        name: config.name,
        body: config.changelog || undefined,
        draft,
        prerelease,
        generate_release_notes: generateNotes,
      }),
    });
    release = await readJson<Release>(created, "GitHub create release");
  } catch (error: unknown) {
    if (statusOf(error) !== 422) throw error;

    const existingResponse = await fetch(
      `${apiUrl}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers },
    );
    if (!existingResponse.ok) throw error;
    release = await readJson<Release>(existingResponse, "GitHub get release");

    if (!generateNotes) {
      const updated = await fetch(`${apiUrl}/repos/${owner}/${repo}/releases/${release.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: config.name,
          body: config.changelog || "",
          draft,
          prerelease,
        }),
      });
      release = await readJson<Release>(updated, "GitHub update release");
    }
  }

  for (const file of config.files) {
    const assetName = path.basename(file);
    const existing = release.assets.find((asset) => asset.name === assetName);
    if (existing) {
      const deleted = await fetch(
        `${apiUrl}/repos/${owner}/${repo}/releases/assets/${existing.id}`,
        { method: "DELETE", headers },
      );
      if (!deleted.ok) {
        throw new Error(
          `GitHub asset delete failed (${deleted.status}): ${await deleted.text()}`,
        );
      }
    }

    const bytes = await fs.readFile(file);
    const uploadUrl = release.upload_url.includes("{?")
      ? release.upload_url.replace(/\{\?[^}]*\}/, `?name=${encodeURIComponent(assetName)}`)
      : `${release.upload_url}${release.upload_url.includes("?") ? "&" : "?"}name=${encodeURIComponent(assetName)}`;
    const uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": contentTypeFor(assetName),
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
    const uploadedData = await readJson<{ browser_download_url?: string }>(
      uploaded,
      `GitHub upload ${assetName}`,
    );
    info(`Uploaded ${assetName} to ${uploadedData.browser_download_url || release.html_url}`);
  }

  setOutput("github-release-id", release.id);
  setOutput("github-release-url", release.html_url);
}

async function publishModrinth(config: PublishConfig): Promise<void> {
  const token = getInput("modrinth-token");
  const projectId = getInput("modrinth-id");
  if (!token || !projectId) {
    info("Skipping Modrinth: no modrinth-token or modrinth-id");
    return;
  }
  setSecret(token);
  if (config.gameVersions.length === 0) {
    throw new Error("game-versions is required for Modrinth publishing");
  }

  const form = new FormData();
  const partNames: string[] = [];
  const fileTypes: Record<string, string> = {};

  for (let index = 0; index < config.files.length; index++) {
    const file = config.files[index];
    const partName = `file-${index}`;
    const bytes = await fs.readFile(file);
    partNames.push(partName);
    form.append(partName, new Blob([bytes]), path.basename(file));
    if (/-sources\.jar$/i.test(path.basename(file))) {
      fileTypes[partName] = "sources-jar";
    }
  }

  const primaryIndex = config.files.indexOf(config.primaryFile);
  const data: Record<string, unknown> = {
    project_id: projectId,
    name: config.name,
    version_number: config.version,
    changelog: config.changelog || null,
    dependencies: config.dependencies.flatMap((dependency) =>
      dependency.modrinth ? [dependency.modrinth] : [],
    ),
    game_versions: config.gameVersions,
    version_type: config.versionType,
    loaders: config.loaders,
    featured: getBooleanInput("modrinth-featured"),
    status: getInput("modrinth-status") || "listed",
    file_parts: partNames,
    primary_file: partNames[primaryIndex] || partNames[0],
  };
  if (Object.keys(fileTypes).length > 0) data.file_types = fileTypes;

  form.append("data", new Blob([JSON.stringify(data)], { type: "application/json" }), "data.json");

  const response = await fetch("https://api.modrinth.com/v2/version", {
    method: "POST",
    headers: {
      Authorization: token,
      "User-Agent": USER_AGENT,
    },
    body: form,
  });
  const version = await readJson<{ id?: string }>(response, "Modrinth upload");
  if (version.id) {
    const versionUrl = `https://modrinth.com/project/${encodeURIComponent(projectId)}/version/${encodeURIComponent(version.id)}`;
    setOutput("modrinth-version-id", version.id);
    setOutput("modrinth-version-url", versionUrl);
    info(`Published to Modrinth: ${projectId}/${version.id} (${versionUrl})`);
  } else {
    info("Published to Modrinth: unknown version id");
  }
}

async function uploadCurseForgeFile(
  token: string,
  projectId: string,
  endpoint: string,
  metadata: Record<string, unknown>,
  file: string,
): Promise<number> {
  const form = new FormData();
  const bytes = await fs.readFile(file);
  form.append("metadata", JSON.stringify(metadata));
  form.append("file", new Blob([bytes]), path.basename(file));

  const response = await fetch(
    `https://${endpoint}.curseforge.com/api/projects/${projectId}/upload-file`,
    {
      method: "POST",
      headers: {
        "X-Api-Token": token,
        "User-Agent": USER_AGENT,
      },
      body: form,
    },
  );
  const result = await readJson<{ id?: number }>(response, "CurseForge upload");
  if (!result.id) throw new Error("CurseForge upload returned no file id");
  return result.id;
}

async function publishCurseforge(config: PublishConfig): Promise<void> {
  const token = getInput("curseforge-token");
  const projectId = getInput("curseforge-id");
  if (!token || !projectId) {
    info("Skipping CurseForge: no curseforge-token or curseforge-id");
    return;
  }
  setSecret(token);
  if (config.gameVersions.length === 0) {
    throw new Error("game-versions is required for CurseForge publishing");
  }

  const endpoint = getInput("curseforge-game-endpoint") || "minecraft";
  const loaderNames = config.loaders.map(capitalize);
  const gameVersionNames = [...config.gameVersions, ...loaderNames];
  if (config.java) gameVersionNames.push(`Java ${config.java}`);

  const baseMetadata: Record<string, unknown> = {
    changelog: config.changelog,
    changelogType: getInput("curseforge-changelog-type") || "markdown",
    displayName: config.name,
    gameVersionNames,
    releaseType: config.versionType,
    isMarkedForManualRelease: false,
    relations: {
      projects: config.dependencies.flatMap((dependency) =>
        dependency.curseforge ? [dependency.curseforge] : [],
      ),
    },
  };

  const primaryId = await uploadCurseForgeFile(
    token,
    projectId,
    endpoint,
    baseMetadata,
    config.primaryFile,
  );

  for (const file of config.files) {
    if (file === config.primaryFile) continue;
    const label = /-sources\.jar$/i.test(path.basename(file)) ? "sources" : path.basename(file);
    const metadata: Record<string, unknown> = {
      ...baseMetadata,
      displayName: `${config.name} (${label})`,
      parentFileID: primaryId,
    };
    delete metadata.gameVersionNames;
    await uploadCurseForgeFile(token, projectId, endpoint, metadata, file);
  }

  setOutput("curseforge-file-id", primaryId);
  info(`Published to CurseForge: ${projectId}/${primaryId}`);
}

async function run(): Promise<void> {
  const config = await loadConfig();
  await publishGithub(config);
  await publishModrinth(config);
  await publishCurseforge(config);
}

run().catch((error: unknown) => {
  console.error(`::error::${getErrorMessage(error)}`);
  process.exitCode = 1;
});