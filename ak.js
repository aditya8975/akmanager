#!/usr/bin/env node
import { program } from "commander";
import chalk from "chalk";
import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import pino from "pino";

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
const DB_PATH = path.join(process.cwd(), "package-db.json");

// In-memory cache
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
  const version = "latest";
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

async function installPackages(packages, isGlobal = false, silent = false) {
  if (!packages.length) {
    if (!silent) logger.error(chalk.yellow("No packages provided"));
    return;
  }
  logger.info(chalk.cyan(`Installing ${packages.join(", ")}...`));
  const cacheHits = [];
  const toInstall = [];

  await Promise.all(packages.map(async (pkg) => {
    const version = await getPackageVersion(pkg);
    const cachePath = path.join(CACHE_DIR, `${pkg}-${version}`);
    if (await fs.access(cachePath).then(() => true).catch(() => false)) {
      cacheHits.push({ pkg, cachePath });
    } else {
      toInstall.push(pkg);
    }
  }));

  await Promise.all(cacheHits.map(async ({ pkg, cachePath }) => {
    const target = path.join(process.cwd(), "node_modules", pkg);
    await fs.symlink(cachePath, target, "dir").catch(() => fs.cp(cachePath, target, { recursive: true }));
    logger.info(chalk.green(`${pkg} cached`));
  }));

  if (toInstall.length) {
    const command = `${isGlobal ? "bun add -g" : "bun add"} ${toInstall.join(" ")}`;
    try {
      await execPromise(command, silent);
      logger.info(chalk.green(`Installed ${toInstall.join(", ")}`));
    } catch (error) {
      logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
    }
  }
}

// CLI setup
program.version("1.0.0").description("ak - Faster than light");

program
  .command("install [packages...]")
  .alias("i")
  .option("-g, --global", "Install globally")
  .option("-s, --silent", "No output")
  .action((packages, options) => installPackages(packages, options.global, options.silent));

program.action(() => logger.warn(chalk.yellow("No command—try 'ak --help'")));

program.parse(process.argv);
