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
    options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" }
  }
});

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

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject({ error, stderr });
      else resolve({ stdout, stderr });
    });
  });
}

// 📦 Install Packages
async function installPackages(packages, isGlobal = false) {
  if (!packages.length) return logger.error(chalk.yellow("No packages provided"));
  logger.info(chalk.cyan(`Installing ${packages.join(", ")}...`));
  const command = `${isGlobal ? "npm install -g" : "npm install"} ${packages.join(" ")}`;
  try {
    await execPromise(command);
    logger.info(chalk.green(`Installed: ${packages.join(", ")}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
  }
}

// 🗑 Uninstall Packages
async function uninstallPackages(packages, isGlobal = false) {
  if (!packages.length) return logger.warn(chalk.yellow("No packages provided"));
  logger.info(chalk.cyan(`Uninstalling ${packages.join(", ")}...`));
  const command = `${isGlobal ? "npm uninstall -g" : "npm uninstall"} ${packages.join(" ")}`;
  try {
    await execPromise(command);
    logger.info(chalk.green(`Uninstalled: ${packages.join(", ")}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
  }
}

// 🔄 Update Packages
async function updatePackages(packages, isGlobal = false) {
  if (!packages.length) return logger.warn(chalk.yellow("No packages provided"));
  logger.info(chalk.cyan(`Updating ${packages.join(", ")}...`));
  const command = `${isGlobal ? "npm update -g" : "npm update"} ${packages.join(" ")}`;
  try {
    await execPromise(command);
    logger.info(chalk.green(`Updated: ${packages.join(", ")}`));
  } catch (error) {
    logger.error(chalk.red(`Failed: ${error.stderr || "Packages not found"}`));
  }
}

// 📃 List Installed Packages
async function listPackages() {
  try {
    const { stdout } = await execPromise("npm list --depth=0");
    logger.info(chalk.cyan("Installed Packages:\n") + stdout);
  } catch (error) {
    logger.error(chalk.red(`Failed to list packages: ${error.stderr}`));
  }
}

// 🔍 Search for a Package
async function searchPackage(pkg) {
  if (!pkg) return logger.warn(chalk.yellow("No package specified for search"));
  logger.info(chalk.cyan(`Searching for package: ${pkg}`));
  try {
    const { stdout } = await execPromise(`npm search ${pkg}`);
    logger.info(chalk.green(stdout));
  } catch (error) {
    logger.error(chalk.red(`Search failed: ${error.stderr}`));
  }
}

// ℹ️ Get Package Info
async function getPackageInfo(pkg) {
  if (!pkg) return logger.warn(chalk.yellow("No package specified"));
  logger.info(chalk.cyan(`Fetching info for package: ${pkg}`));
  try {
    const { stdout } = await execPromise(`npm info ${pkg}`);
    logger.info(chalk.green(stdout));
  } catch (error) {
    logger.error(chalk.red(`Failed to fetch package info: ${error.stderr}`));
  }
}

// 🚀 Run a Script from package.json
async function runScript(scriptName) {
  if (!scriptName) return logger.warn(chalk.yellow("No script specified"));
  logger.info(chalk.cyan(`Running script: ${scriptName}`));
  try {
    const { stdout } = await execPromise(`npm run ${scriptName}`);
    logger.info(chalk.green(stdout));
  } catch (error) {
    logger.error(chalk.red(`Failed to run script: ${error.stderr}`));
  }
}

// 🆕 Initialize a New Package
async function initPackage() {
  logger.info(chalk.cyan("Initializing new package.json..."));
  try {
    await execPromise("npm init -y");
    logger.info(chalk.green("package.json created successfully"));
  } catch (error) {
    logger.error(chalk.red(`Failed to initialize package: ${error.stderr}`));
  }
}

// CLI setup
program.version("1.0.0").description("ak - Faster than light");

// 📦 Install
program.command("install [packages...]")
  .alias("i")
  .option("-g, --global", "Install globally")
  .action((packages, options) => installPackages(packages, options.global));

// 🗑 Uninstall
program.command("uninstall [packages...]")
  .alias("un")
  .option("-g, --global", "Uninstall globally")
  .action((packages, options) => uninstallPackages(packages, options.global));

// 🔄 Update
program.command("update [packages...]")
  .alias("up")
  .option("-g, --global", "Update globally")
  .action((packages, options) => updatePackages(packages, options.global));

// 📃 List Packages
program.command("list")
  .alias("ls")
  .action(listPackages);

// 🔍 Search Package
program.command("search <pkg>")
  .action(searchPackage);

// ℹ️ Get Package Info
program.command("info <pkg>")
  .action(getPackageInfo);

// 🚀 Run Script
program.command("run <script>")
  .action(runScript);

// 🆕 Init
program.command("init")
  .action(initPackage);

// Default message
program.action(() => logger.warn(chalk.yellow("No command—try 'ak --help'")));

program.parse(process.argv);
