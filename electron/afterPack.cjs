const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const targetPlatform = context.packager.platform.name;
  const resourcesDir = targetPlatform === "mac"
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
      )
    : path.join(context.appOutDir, "resources");

  const nodeDir = path.join(resourcesDir, "node");
  fs.mkdirSync(nodeDir, { recursive: true });

  const target = path.join(nodeDir, targetPlatform === "windows" ? "node.exe" : "node");
  fs.copyFileSync(process.execPath, target);

  if (targetPlatform !== "windows") {
    fs.chmodSync(target, 0o755);
  }

  console.log(`[afterPack] bundled Node runtime: ${target}`);
};
