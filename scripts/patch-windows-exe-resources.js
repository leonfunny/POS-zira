const fs = require('fs');
const path = require('path');

function loadResEdit() {
  const appBuilderLibRoot = path.dirname(require.resolve('app-builder-lib/package.json'));
  return require(require.resolve('resedit', { paths: [appBuilderLibRoot, process.cwd()] }));
}

const ResEdit = loadResEdit();

const WINDOWS_LANG_EN_US = 1033;
const WINDOWS_CODEPAGE_UNICODE = 1200;

function toWindowsVersion(version) {
  const parts = String(version)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
    .slice(0, 4);

  while (parts.length < 4) {
    parts.push(0);
  }

  return parts.join('.');
}

function parseCompanyName(author, fallback) {
  if (typeof author === 'object' && author && typeof author.name === 'string') {
    return author.name;
  }

  if (typeof author === 'string' && author.trim()) {
    return author.replace(/\s*<[^>]+>\s*$/, '').trim();
  }

  return fallback;
}

function firstVersionLanguage(versionInfo) {
  return (
    versionInfo.getAllLanguagesForStringValues()[0] ||
    versionInfo.getAvailableLanguages()[0] || {
      lang: WINDOWS_LANG_EN_US,
      codepage: WINDOWS_CODEPAGE_UNICODE,
    }
  );
}

module.exports = async function patchWindowsExeResources(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const packageJson = require(path.join(repoRoot, 'package.json'));
  const appInfo = context.packager.appInfo;
  const productName = appInfo.productName || packageJson.build.productName || 'Zira';
  const productFilename = appInfo.productFilename || productName;
  const companyName = appInfo.companyName || parseCompanyName(packageJson.author, productName);
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(repoRoot, packageJson.build.win.icon);

  if (!fs.existsSync(exePath)) {
    throw new Error(`Cannot patch Windows resources: executable not found at ${exePath}`);
  }

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const iconGroup = iconGroups[0] || { id: 1, lang: WINDOWS_LANG_EN_US };

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroup.id,
    iconGroup.lang,
    iconFile.icons.map((item) => item.data)
  );

  const version = toWindowsVersion(packageJson.version);
  const versionInfoList = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const versionInfo =
    versionInfoList[0] ||
    ResEdit.Resource.VersionInfo.create({
      lang: WINDOWS_LANG_EN_US,
      fixedInfo: {},
      strings: [],
    });
  const language = firstVersionLanguage(versionInfo);

  versionInfo.setFileVersion(version, language.lang);
  versionInfo.setProductVersion(version, language.lang);
  versionInfo.setStringValues(
    language,
    {
      CompanyName: companyName,
      FileDescription: packageJson.description || productName,
      FileVersion: version,
      InternalName: productFilename,
      LegalCopyright: packageJson.build.copyright || '',
      OriginalFilename: `${productFilename}.exe`,
      ProductName: productName,
      ProductVersion: version,
    },
    true
  );
  versionInfo.outputToResourceEntries(resources.entries);

  resources.outputResource(exe);
  const output = Buffer.from(exe.generate());
  const tempPath = `${exePath}.resources.tmp`;
  fs.writeFileSync(tempPath, output);
  fs.renameSync(tempPath, exePath);
};
