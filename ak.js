#!/usr/bin/env node
const { program } = require("commander");
const chalk = require("chalk"); // Works with chalk@4

const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const pino = require("pino");
const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true, 
      translateTime: "HH:MM:ss", 
      ignore: "pid,hostname" 
    }
  }
});
const POPULAR_PACKAGES = ["express", "react", "lodash", "axios", "moment", "chalk", "mongoose"];

const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".prebuilt-cache");
const DB_PATH = path.join(__dirname, "package-db.json");

// In-memory cache for speed
const versionCache = new Map();

async function loadPackageDB() {
  try {
    const data = await fs.readFile(DB_PATH, "utf8");
    const db = JSON.parse(data);
    Object.entries(db).forEach(([pkg, ver]) => versionCache.set(pkg, ver));
    return db;
  } catch (e) {
    return {};
  }
}

async function savePackageDB(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

async function getPackageVersion(pkgName) {
  if (versionCache.has(pkgName)) return versionCache.get(pkgName);
  const db = await loadPackageDB();
  if (db[pkgName]) {
    versionCache.set(pkgName, db[pkgName]);
    return db[pkgName];
  }
  const version = "latest"; // Replace with real fetching if needed
  db[pkgName] = version;
  versionCache.set(pkgName, version);
  await savePackageDB(db);
  return version;
}

function execPromise(command, silent = false) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject({ error, stderr });
      else resolve({ stdout, stderr });
    });
  });
}

// Batch install
async function installPackages(packages, isGlobal = false, silent = false) {
  if (!packages.length) {
    if (!silent) logger.error(chalk.yellow("No packages provided"));
    return;
  }
  if (!silent) logger.info(chalk.cyan(`Installing ${packages.join(", ")}...`));
  const cacheHits = [];
  const toInstall = [];

  await Promise.all(packages.map(async pkg => {
    const version = await getPackageVersion(pkg);
    const cachePath = path.join(CACHE_DIR, `${pkg}-${version}`);
    if (await fs.access(cachePath).then(() => true).catch(() => false)) {
      cacheHits.push({ pkg, cachePath });
    } else {
      toInstall.push(pkg);
    }
  }));

  // Restore cached packages
  await Promise.all(cacheHits.map(async ({ pkg, cachePath }) => {
    const target = path.join(process.cwd(), "node_modules", pkg);
    await fs.symlink(cachePath, target, "dir").catch(() => fs.cp(cachePath, target, { recursive: true }));
    if (!silent) logger.info(chalk.green(`${pkg} cached`));
  }));

  // Batch install remaining
  if (toInstall.length) {
    const command = `${isGlobal ? "bun add -g" : "bun add"} ${toInstall.join(" ")} ${silent ? "--no-save" : ""}`;
    try {
      await execPromise(command, silent);
      await Promise.all(toInstall.map(async pkg => {
        const cachePath = path.join(CACHE_DIR, `${pkg}-latest`);
        const nodeModulesPath = path.join(process.cwd(), "node_modules", pkg);
        if (await fs.access(nodeModulesPath).then(() => true).catch(() => false)) {
          await fs.symlink(nodeModulesPath, cachePath, "dir").catch(() => fs.cp(nodeModulesPath, cachePath, { recursive: true }));
        }
      }));
      if (!silent) logger.info(chalk.green(`Installed ${toInstall.join(", ")}`));
    } catch (error) {
      if (!silent) logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
      throw error;
    }
  }
}

// Uninstall packages
async function uninstallPackages(packages, isGlobal = false, silent = false) {
  if (!packages.length) {
    if (!silent) logger.warn(chalk.yellow("No packages provided"));
    return;
  }
  if (!silent) logger.warn(chalk.cyan(`Uninstalling ${packages.join(", ")}...`));
  const command = `${isGlobal ? "bun remove -g" : "bun remove"} ${packages.join(" ")}`;
  try {
    await execPromise(command, silent);
    if (!silent) logger.info(chalk.green(`Uninstalled ${packages.join(", ")}`));
  } catch (error) {
    if (!silent) logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
    throw error;
  }
}

// Update packages
async function updatePackages(packages, isGlobal = false, silent = false) {
  if (!packages.length) {
    if (!silent) logger.warn(chalk.yellow("No packages provided"));
    return;
  }
  if (!silent) logger.info(chalk.cyan(`Updating ${packages.join(", ")}...`));
  const command = `${isGlobal ? "bun update -g" : "bun update"} ${packages.join(" ")}`;
  try {
    await execPromise(command, silent);
    await Promise.all(packages.map(async pkg => {
      const cachePath = path.join(CACHE_DIR, `${pkg}-latest`);
      const nodeModulesPath = path.join(process.cwd(), "node_modules", pkg);
      if (await fs.access(nodeModulesPath).then(() => true).catch(() => false)) {
        await fs.rm(cachePath, { recursive: true, force: true });
        await fs.symlink(nodeModulesPath, cachePath, "dir").catch(() => fs.cp(nodeModulesPath, cachePath, { recursive: true }));
      }
    }));
    if (!silent) logger.info(chalk.green(`Updated ${packages.join(", ")}`));
  } catch (error) {
    if (!silent) logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
    throw error;
  }
}

// List cached packages
async function listCachedPackages(silent = false) {
  const db = await loadPackageDB();
  if (!Object.keys(db).length) {
    if (!silent) logger.warn(chalk.yellow("No cached packages"));
    return;
  }
  if (!silent) {
    logger.info(chalk.cyan("Cached:"));
    Object.entries(db).forEach(([pkg, ver]) => logger.info(chalk.green(`  ${pkg}@${ver}`)));
  }
}

// CLI setup
program
  .version("1.0.0")
  .description("ak - Faster than light");

program
  .command("install [packages...]")
  .alias("i")
  .option("-g, --global", "Install globally")
  .option("-s, --silent", "No output")
  .action((packages, options) => installPackages(packages, options.global, options.silent));

program
  .command("uninstall [packages...]")
  .alias("un")
  .option("-g, --global", "Uninstall globally")
  .option("-s, --silent", "No output")
  .action((packages, options) => uninstallPackages(packages, options.global, options.silent));

program
  .command("update [packages...]")
  .alias("up")
  .option("-g, --global", "Update globally")
  .option("-s, --silent", "No output")
  .action((packages, options) => updatePackages(packages, options.global, options.silent));

program
  .command("list")
  .alias("ls")
  .option("-s, --silent", "No output")
  .action(options => listCachedPackages(options.silent));

program.action(() => logger.warn(chalk.yellow("No command—try 'ak --help'")));

program.parse(process.argv);