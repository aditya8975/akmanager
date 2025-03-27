#!/usr/bin/env bun
import { program } from "commander";
import chalk from "chalk";
import { exec } from "child_process";
import { promises as fsPromises } from "fs";
import * as fs from "fs";
import path from "path";
import pino from "pino";
import fetch from "node-fetch";
import { createHash } from "crypto";
import dotenv from "dotenv";

dotenv.config();

const CACHE_DIR = process.env.AKMANAGER_CACHE_DIR || path.join(os.homedir(), ".akmanager-cache");
const MANIFEST_PATH = path.join(CACHE_DIR, "cache-manifest.json");
const INSTALL_TIMEOUT = parseInt(process.env.AKMANAGER_INSTALL_TIMEOUT, 10) || 30000;
const REGISTRY_URL = process.env.AKMANAGER_REGISTRY_URL || "https://registry.npmjs.org";
const BUN_PATH = process.env.AKMANAGER_BUN_PATH || "bun";
const GLOBAL_DIR = process.env.AKMANAGER_GLOBAL_DIR || path.join(os.homedir(), ".bun", "install", "global");

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
});

const versionCache = new Map();

async function getPackageVersion(pkg, forceLatest = false) {
  if (!forceLatest && versionCache.has(pkg)) return versionCache.get(pkg);
  const res = await fetch(`${REGISTRY_URL}/${pkg}`);
  if (!res.ok) throw new Error(`Package ${pkg} not found`);
  const data = await res.json();
  const version = data["dist-tags"].latest;
  versionCache.set(pkg, version);
  return version;
}

function sanitizeInput(pkg) {
  if (!/^[a-zA-Z0-9-_@\/]+$/.test(pkg)) throw new Error(`Invalid package: ${pkg}`);
  return pkg;
}

async function execPromise(command, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const fullCommand = `${BUN_PATH} ${command}`;
      logger.info(`Executing: ${fullCommand}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), INSTALL_TIMEOUT);
      const result = await new Promise((resolve, reject) => {
        exec(fullCommand, { signal: controller.signal, shell: true }, (error, stdout, stderr) => {
          clearTimeout(timeoutId);
          logger.info(`Output: ${stdout}`);
          if (error) reject({ error, stderr });
          else resolve({ stdout, stderr });
        });
      });
      return result;
    } catch (error) {
      if (i === retries - 1) {
        logger.error(chalk.red(`Failed: ${error.stderr || error.message}`));
        throw error;
      }
      logger.warn(chalk.yellow(`Retry ${i + 1}/${retries} for ${command}`));
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function cachePackage(pkg, version = "latest") {
  const res = await fetch(`${REGISTRY_URL}/${pkg}`);
  const data = await res.json();
  const pkgVersion = version === "latest" ? data["dist-tags"].latest : version;
  const tarballUrl = data.versions[pkgVersion].dist.tarball;
  const integrity = data.versions[pkgVersion].dist.integrity;

  const cachePath = path.join(CACHE_DIR, `${pkg}-${pkgVersion}.tgz`);
  await fsPromises.mkdir(CACHE_DIR, { recursive: true });

  if (!(await fsPromises.access(cachePath).then(() => true).catch(() => false))) {
    const tarball = await fetch(tarballUrl);
    logger.info(`Downloading ${tarballUrl} to ${cachePath}`);
    const writeStream = fs.createWriteStream(cachePath);
    await new Promise((resolve, reject) => {
      tarball.body.pipe(writeStream);
      writeStream.on("finish", () => logger.info(`Wrote ${cachePath}`) && resolve());
      writeStream.on("error", reject);
    });
  }

  const hash = createHash("sha512");
  hash.update(await fsPromises.readFile(cachePath));
  if (`sha512-${hash.digest("base64")}` !== integrity) {
    await fsPromises.unlink(cachePath);
    throw new Error(`Integrity check failed for ${pkg}@${pkgVersion}`);
  }

  const manifest = await fsPromises.readFile(MANIFEST_PATH, "utf8").then(JSON.parse).catch(() => ({}));
  manifest[`${pkg}@${pkgVersion}`] = { path: cachePath, integrity };
  await fsPromises.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return cachePath;
}

async function getCachedPackage(pkg, version) {
  const manifest = await fsPromises.readFile(MANIFEST_PATH, "utf8").then(JSON.parse).catch(() => ({}));
  const key = `${pkg}@${version}`;
  if (manifest[key]) {
    const { path: cachePath, integrity } = manifest[key];
    const hash = createHash("sha512");
    hash.update(await fsPromises.readFile(cachePath));
    if (`sha512-${hash.digest("base64")}` !== integrity) {
      await fsPromises.unlink(cachePath);
      delete manifest[key];
      await fsPromises.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
      return null;
    }
    return cachePath;
  }
  return null;
}

async function ensurePackageJson() {
  const pkgJsonPath = path.join(process.cwd(), "package.json");
  if (!(await fsPromises.access(pkgJsonPath).then(() => true).catch(() => false))) {
    const defaultPkgJson = {
      name: path.basename(process.cwd()),
      version: "1.0.0",
      description: "",
      main: "index.js",
      scripts: { test: "echo \"Error: no test specified\" && exit 1" },
      dependencies: {},
    };
    await fsPromises.writeFile(pkgJsonPath, JSON.stringify(defaultPkgJson, null, 2));
    logger.info(`Created package.json at ${pkgJsonPath}`);
  }
}

async function installPackages(packages, options) {
  try {
    const safePackages = packages.map(sanitizeInput);
    logger.info(`Processing packages: ${safePackages.join(", ")}`);

    // Ensure package.json exists for local installs
    if (!options.global) {
      await ensurePackageJson();
    }

    const cached = await Promise.all(safePackages.map(async pkg => {
      const version = await getPackageVersion(pkg, options.force);
      const cachePath = await getCachedPackage(pkg, version) || await cachePackage(pkg, version);
      logger.info(`Installing cached package: ${cachePath}`);
      const flags = `${options.global ? "-g" : ""} ${options.force ? "--force" : ""} ${options.legacyPeerDeps ? "--legacy-peer-deps" : ""}`;
      await execPromise(`add "${cachePath}" ${flags}`); // Removed --no-save
      return pkg;
    })).then(results => results.filter(Boolean));

    const uncached = safePackages.filter(pkg => !cached.includes(pkg));
    if (uncached.length) {
      logger.info(`Installing uncached packages: ${uncached.join(", ")}`);
      const flags = `${options.global ? "-g" : ""} ${options.force ? "--force" : ""} ${options.legacyPeerDeps ? "--legacy-peer-deps" : ""}`;
      await execPromise(`add ${uncached.join(" ")} ${flags}`);
    }
    logger.info(chalk.green(`Installed: ${safePackages.join(", ")}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || error.message}`));
    process.exit(1);
  }
}

async function uninstallPackages(packages, options) {
  try {
    const safePackages = packages.map(sanitizeInput);
    logger.info(`Uninstalling packages: ${safePackages.join(", ")}`);
    const targetDir = options.global ? path.join(GLOBAL_DIR, "node_modules") : path.join(process.cwd(), "node_modules");
    const flags = `${options.global ? "-g" : ""}`;

    const existingPackages = [];
    const missingPackages = [];

    for (const pkg of safePackages) {
      const pkgDir = path.join(targetDir, pkg);
      const exists = await fsPromises.access(pkgDir).then(() => true).catch(() => false);
      if (exists) {
        existingPackages.push(pkg);
      } else {
        missingPackages.push(pkg);
      }
    }

    if (missingPackages.length > 0) {
      logger.warn(chalk.yellow(`Packages not found: ${missingPackages.join(", ")}. Skipping uninstallation for these.`));
    }

    if (existingPackages.length === 0) {
      logger.info(chalk.yellow("No packages to uninstall."));
      return;
    }

    const { stdout, stderr } = await execPromise(`remove ${existingPackages.join(" ")} ${flags}`);
    
    const stillExisting = [];
    for (const pkg of existingPackages) {
      const pkgDir = path.join(targetDir, pkg);
      if (await fsPromises.access(pkgDir).then(() => true).catch(() => false)) {
        stillExisting.push(pkg);
      }
    }

    if (stillExisting.length > 0) {
      logger.error(chalk.red(`Failed to uninstall: ${stillExisting.join(", ")}`));
      process.exit(1);
    }

    logger.info(chalk.green(`Uninstalled: ${existingPackages.join(", ")}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || error.message}`));
    process.exit(1);
  }
}

async function listPackages(options) {
  try {
    logger.info(`Listing installed packages${options.global ? " (global)" : ""}...`);
    const targetDir = options.global ? path.join(GLOBAL_DIR, "node_modules") : path.join(process.cwd(), "node_modules");
    const pkgJsonPath = options.global ? null : path.join(process.cwd(), "package.json");

    let pkgList = [];

    try {
      const dirs = await fsPromises.readdir(targetDir);
      pkgList = await Promise.all(
        dirs
          .filter(dir => !dir.startsWith(".") && !dir.startsWith("@"))
          .map(async dir => {
            const pkgPath = path.join(targetDir, dir, "package.json");
            try {
              const pkgData = JSON.parse(await fsPromises.readFile(pkgPath, "utf8"));
              return `${pkgData.name}@${pkgData.version}`;
            } catch {
              return null;
            }
          })
      );

      const scopedDirs = dirs.filter(dir => dir.startsWith("@"));
      for (const scope of scopedDirs) {
        const subDirs = await fsPromises.readdir(path.join(targetDir, scope));
        const scopedPkgs = await Promise.all(
          subDirs.map(async subDir => {
            const pkgPath = path.join(targetDir, scope, subDir, "package.json");
            try {
              const pkgData = JSON.parse(await fsPromises.readFile(pkgPath, "utf8"));
              return `${pkgData.name}@${pkgData.version}`;
            } catch {
              return null;
            }
          })
        );
        pkgList.push(...scopedPkgs);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    pkgList = pkgList.filter(Boolean).sort();

    if (!options.global && pkgJsonPath) {
      try {
        const pkgJson = JSON.parse(await fsPromises.readFile(pkgJsonPath, "utf8"));
        const deps = {
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies,
          ...pkgJson.optionalDependencies
        };
        pkgList = Object.entries(deps).map(([name, version]) => `${name}@${version}`);
      } catch (error) {
        if (error.code !== "ENOENT") logger.warn(chalk.yellow("No package.json found, listing node_modules only"));
      }
    }

    logger.info(chalk.green(`Installed packages:\n${pkgList.join("\n") || "None"}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.message}`));
    process.exit(1);
  }
}

async function updatePackages(packages, options) {
  try {
    const safePackages = packages.length ? packages.map(sanitizeInput) : [];
    logger.info(`Updating ${safePackages.length ? "packages: " + safePackages.join(", ") : "all packages"}`);
    const flags = `${options.global ? "-g" : ""} ${options.force ? "--force" : ""} ${options.legacyPeerDeps ? "--legacy-peer-deps" : ""}`;
    if (safePackages.length) {
      await execPromise(`add ${safePackages.join(" ")} ${flags}`);
    } else {
      await execPromise(`install ${flags}`);
    }
    logger.info(chalk.green(`Updated: ${safePackages.length ? safePackages.join(", ") : "all packages"}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || error.message}`));
    process.exit(1);
  }
}

async function cleanCache() {
  try {
    logger.info("Cleaning cache...");
    const manifest = await fsPromises.readFile(MANIFEST_PATH, "utf8").then(JSON.parse).catch(() => ({}));
    const files = await fsPromises.readdir(CACHE_DIR);
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      if (!Object.values(manifest).some(entry => entry.path === filePath)) {
        await fsPromises.unlink(filePath);
        logger.info(`Removed: ${filePath}`);
      }
    }
    logger.info(chalk.green("Cache cleaned"));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.message}`));
    process.exit(1);
  }
}

program
  .version("1.1.0")
  .description("akmanager - The Fastest JavaScript Package Manager");

program
  .command("install [packages...]")
  .alias("i")
  .description("Install one or more packages")
  .option("-g, --global", "Install globally")
  .option("-f, --force", "Force installation, overwriting conflicts")
  .option("--legacy-peer-deps", "Resolve peer dependencies in a legacy manner")
  .action(installPackages);

program
  .command("uninstall [packages...]")
  .alias("un")
  .description("Uninstall one or more packages")
  .option("-g, --global", "Uninstall globally")
  .action(uninstallPackages);

program
  .command("list")
  .alias("ls")
  .description("List installed packages")
  .option("-g, --global", "List global packages")
  .action(listPackages);

program
  .command("update [packages...]")
  .alias("up")
  .description("Update one or more packages (or all if none specified)")
  .option("-g, --global", "Update globally")
  .option("-f, --force", "Force update, overwriting conflicts")
  .option("--legacy-peer-deps", "Resolve peer dependencies in a legacy manner")
  .action(updatePackages);

program
  .command("clean")
  .description("Clean unused cache files")
  .action(cleanCache);

program.parse(process.argv);