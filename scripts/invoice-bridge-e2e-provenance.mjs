import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const INVOICE_BRIDGE_E2E_PROVENANCE_FILENAME =
  'invoice-bridge-e2e-provenance.json';
export const INVOICE_BRIDGE_E2E_PROVENANCE_KIND =
  'ZIRA_POS_INVOICE_BRIDGE_E2E_PROVENANCE';
export const INVOICE_BRIDGE_E2E_PROVENANCE_VERSION = 1;
export const INVOICE_BRIDGE_E2E_BUILD_STAMP_KIND =
  'ZIRA_POS_INVOICE_BRIDGE_E2E_BUILD_STAMP';
export const INVOICE_BRIDGE_E2E_BUILD_STAMP_VERSION = 1;
export const INVOICE_BRIDGE_E2E_BUILD_STAMP_SOURCE_RELATIVE = path.join(
  'src',
  'main',
  'invoice-gateway',
  'invoice-bridge-e2e-build-stamp.ts',
);
export const INVOICE_BRIDGE_E2E_BUILD_STAMP_JS =
  'invoice-bridge-e2e-build-stamp.js';
export const INVOICE_BRIDGE_E2E_GATEWAY_MODULES = [
  'client.js',
  'token.js',
  'errors.js',
  'contract.js',
];
export const INVOICE_BRIDGE_E2E_GATEWAY_SOURCES = [
  'client.ts',
  'token.ts',
  'errors.ts',
  'contract.ts',
];

const COMPILED_GATEWAY_RELATIVE = path.join('dist', 'main', 'invoice-gateway');
const PACKAGED_APP_RELATIVE = path.join(
  'release',
  'win-unpacked',
  'resources',
  'app',
);
const BUILD_STAMP_BASE64_NAME = 'INVOICE_BRIDGE_E2E_BUILD_STAMP_BASE64';

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function requireGitObjectId(value, label) {
  const objectId = String(value || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
    throw new Error(`${label} must be a full Git object ID`);
  }
  return objectId;
}

async function gitOutput(posRoot, args) {
  const { stdout } = await execFileAsync('git', ['-C', posRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout).trim();
}

export async function canonicalPosRoot(value) {
  const input = String(value || '').trim();
  if (!input || !path.isAbsolute(input)) {
    throw new Error('Canonical POS root is required');
  }
  const resolved = path.resolve(input);
  const stats = await lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('POS root must be a real directory, not a link');
  }
  const canonical = await realpath(resolved);
  if (!samePath(resolved, canonical)) {
    throw new Error('POS root must use its canonical path');
  }
  const gitRoot = await realpath(path.resolve(
    await gitOutput(canonical, ['rev-parse', '--show-toplevel']),
  ));
  if (!samePath(gitRoot, canonical)) {
    throw new Error('POS root is not the exact Git worktree root');
  }
  return canonical;
}

export async function readCleanGitIdentity(
  posRoot,
  { expectedPosCommit, expectedPosTree } = {},
) {
  const head = requireGitObjectId(
    await gitOutput(posRoot, ['rev-parse', 'HEAD']),
    'POS worktree HEAD',
  );
  const tree = requireGitObjectId(
    await gitOutput(posRoot, ['rev-parse', 'HEAD^{tree}']),
    'POS worktree HEAD tree',
  );
  if (expectedPosCommit !== undefined) {
    const expected = requireGitObjectId(expectedPosCommit, 'Expected POS commit');
    if (head !== expected) {
      throw new Error('POS worktree HEAD does not match expected commit');
    }
  }
  if (expectedPosTree !== undefined) {
    const expected = requireGitObjectId(expectedPosTree, 'Expected POS tree');
    if (tree !== expected) {
      throw new Error('POS worktree HEAD tree does not match expected tree');
    }
  }
  const changes = await gitOutput(posRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (changes) {
    throw new Error('POS worktree must be clean before provenance verification');
  }
  return { head, tree };
}

async function assertCanonicalDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  const stats = await lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a link`);
  }
  const canonical = await realpath(resolved);
  if (!samePath(canonical, resolved)) {
    throw new Error(`${label} must use its canonical path`);
  }
  return canonical;
}

export async function assertRegularCanonicalFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const canonical = await realpath(resolved);
  if (!samePath(canonical, resolved)) {
    throw new Error(`${label} must use its canonical path`);
  }
  return canonical;
}

export async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function describeFile(filePath, label) {
  const canonical = await assertRegularCanonicalFile(filePath, label);
  const stats = await lstat(canonical);
  return {
    sha256: await sha256File(canonical),
    bytes: stats.size,
  };
}

async function describeRootFiles(posRoot) {
  return {
    'package.json': await describeFile(
      path.join(posRoot, 'package.json'),
      'POS package.json',
    ),
    'package-lock.json': await describeFile(
      path.join(posRoot, 'package-lock.json'),
      'POS package-lock.json',
    ),
    'tsconfig.main.json': await describeFile(
      path.join(posRoot, 'tsconfig.main.json'),
      'POS tsconfig.main.json',
    ),
  };
}

async function describeGatewaySources(posRoot) {
  const sources = {};
  for (const filename of INVOICE_BRIDGE_E2E_GATEWAY_SOURCES) {
    sources[filename] = await describeFile(
      path.join(posRoot, 'src', 'main', 'invoice-gateway', filename),
      `POS invoice bridge source ${filename}`,
    );
  }
  return sources;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function assertSameJson(actual, expected, message) {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(message);
}

function validateBuildStamp(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== INVOICE_BRIDGE_E2E_BUILD_STAMP_VERSION
    || value.kind !== INVOICE_BRIDGE_E2E_BUILD_STAMP_KIND
    || !/^[0-9a-f]{64}$/.test(String(value.invocationId || ''))
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.git?.head || ''))
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(value.git?.tree || ''))
    || !/^[0-9a-f]{64}$/.test(String(value.rootFiles?.['package.json']?.sha256 || ''))
    || !/^[0-9a-f]{64}$/.test(String(value.rootFiles?.['package-lock.json']?.sha256 || ''))
    || !/^[0-9a-f]{64}$/.test(String(value.rootFiles?.['tsconfig.main.json']?.sha256 || ''))
    || INVOICE_BRIDGE_E2E_GATEWAY_SOURCES.some(
      (filename) => !/^[0-9a-f]{64}$/.test(
        String(value.gatewaySources?.[filename]?.sha256 || ''),
      ),
    )
  ) {
    throw new Error('POS E2E build stamp is invalid');
  }
  return value;
}

function encodeBuildStamp(value) {
  return Buffer.from(stableJson(validateBuildStamp(value)), 'utf8').toString('base64url');
}

function decodeBuildStamp(encoded) {
  try {
    const canonical = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = validateBuildStamp(JSON.parse(canonical));
    if (encodeBuildStamp(parsed) !== encoded) throw new Error('non-canonical');
    return parsed;
  } catch {
    throw new Error('POS E2E build stamp encoding is invalid');
  }
}

function buildStampSourceContents(stamp) {
  const encoded = encodeBuildStamp(stamp);
  return [
    '// Generated only by the isolated invoice bridge E2E package lane.',
    `export const ${BUILD_STAMP_BASE64_NAME} = '${encoded}';`,
    `export const INVOICE_BRIDGE_E2E_BUILD_STAMP = ${JSON.stringify(stamp, null, 2)} as const;`,
    '',
  ].join('\n');
}

function extractBuildStamp(text, label) {
  const pattern = new RegExp(`${BUILD_STAMP_BASE64_NAME}\\s*=\\s*['\"]([A-Za-z0-9_-]+)['\"]`, 'g');
  const matches = [...String(text).matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one E2E build stamp`);
  }
  return decodeBuildStamp(matches[0][1]);
}

export function buildStampSourcePath(posRoot) {
  return path.join(posRoot, INVOICE_BRIDGE_E2E_BUILD_STAMP_SOURCE_RELATIVE);
}

export async function writeInvoiceBridgeE2eBuildStamp(options = {}) {
  const posRoot = await canonicalPosRoot(options.posRoot);
  const git = await readCleanGitIdentity(posRoot, {
    expectedPosCommit: options.expectedPosCommit,
    expectedPosTree: options.expectedPosTree,
  });
  const stamp = {
    schemaVersion: INVOICE_BRIDGE_E2E_BUILD_STAMP_VERSION,
    kind: INVOICE_BRIDGE_E2E_BUILD_STAMP_KIND,
    invocationId: randomBytes(32).toString('hex'),
    git,
    rootFiles: await describeRootFiles(posRoot),
    gatewaySources: await describeGatewaySources(posRoot),
  };
  await writeFile(
    buildStampSourcePath(posRoot),
    buildStampSourceContents(stamp),
    { encoding: 'utf8', flag: 'wx' },
  );
  return stamp;
}

export async function removeInvoiceBridgeE2eBuildStampSource(posRoot) {
  try {
    await unlink(buildStampSourcePath(posRoot));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readBuildStampArtifact(filePath, label) {
  const description = await describeFile(filePath, label);
  const text = await readFile(filePath, 'utf8');
  return {
    stamp: extractBuildStamp(text, label),
    description,
    text,
  };
}

async function verifyCompiledBuildStamp(
  posRoot,
  git,
  rootFiles,
  gatewaySources,
  { requireSource = false, expectedStamp } = {},
) {
  const source = requireSource
    ? await readBuildStampArtifact(
      buildStampSourcePath(posRoot),
      'POS E2E build stamp source',
    )
    : null;
  const expected = source?.stamp ?? validateBuildStamp(expectedStamp);
  const compiled = await readBuildStampArtifact(
    path.join(compiledGatewayRoot(posRoot), INVOICE_BRIDGE_E2E_BUILD_STAMP_JS),
    'Compiled POS E2E build stamp',
  );
  const packaged = await readBuildStampArtifact(
    path.join(
      packagedAppRoot(posRoot),
      COMPILED_GATEWAY_RELATIVE,
      INVOICE_BRIDGE_E2E_BUILD_STAMP_JS,
    ),
    'Packaged POS E2E build stamp',
  );
  assertSameJson(expected.git, git, 'POS E2E build stamp Git identity is stale');
  assertSameJson(
    expected.rootFiles,
    rootFiles,
    'POS E2E build stamp package inputs are stale',
  );
  assertSameJson(
    expected.gatewaySources,
    gatewaySources,
    'POS E2E build stamp gateway sources are stale',
  );
  assertSameJson(
    compiled.stamp,
    expected,
    'Compiled POS output was not built by this E2E invocation',
  );
  assertSameJson(
    packaged.stamp,
    expected,
    'Packaged POS output was not built by this E2E invocation',
  );
  if (
    compiled.text !== packaged.text
    || compiled.description.sha256 !== packaged.description.sha256
    || compiled.description.bytes !== packaged.description.bytes
  ) {
    throw new Error('Compiled and packaged POS E2E build stamp modules differ');
  }
  return {
    value: expected,
    module: compiled.description,
  };
}

export async function describeRegularFileTree(directoryPath, label) {
  const root = await assertCanonicalDirectory(directoryPath, label);
  const files = [];

  async function walk(current, relativeDirectory) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} contains a non-regular entry: ${relative}`);
      }
      const description = await describeFile(absolute, `${label} file ${relative}`);
      files.push({ path: relative, ...description });
    }
  }

  await walk(root, '');
  if (files.length === 0) throw new Error(`${label} must not be empty`);
  const treeHash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    treeHash.update(file.path, 'utf8');
    treeHash.update('\0');
    treeHash.update(file.sha256, 'ascii');
    treeHash.update('\0');
    treeHash.update(String(file.bytes), 'ascii');
    treeHash.update('\n');
  }
  return {
    treeSha256: treeHash.digest('hex'),
    fileCount: files.length,
    bytes,
  };
}

async function describeWsTree(wsRoot, label) {
  const packageJsonPath = path.join(wsRoot, 'package.json');
  const packageJsonText = await readFile(
    await assertRegularCanonicalFile(packageJsonPath, `${label} package.json`),
    'utf8',
  );
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch {
    throw new Error(`${label} package.json is invalid`);
  }
  if (packageJson?.name !== 'ws' || typeof packageJson?.version !== 'string') {
    throw new Error(`${label} is not the ws runtime package`);
  }
  return {
    version: packageJson.version,
    packageJsonSha256: createHash('sha256').update(packageJsonText).digest('hex'),
    ...await describeRegularFileTree(wsRoot, label),
  };
}

async function describeRuntimeWs(posRoot) {
  const appRoot = packagedAppRoot(posRoot);
  const wsRoot = await assertCanonicalDirectory(
    path.join(appRoot, 'node_modules', 'ws'),
    'Packaged POS ws runtime tree',
  );
  const client = await assertRegularCanonicalFile(
    packagedClientPath(posRoot),
    'Packaged POS invoice bridge client',
  );
  const resolver = [
    "const { createRequire } = require('node:module');",
    "process.stdout.write(createRequire(process.argv[1]).resolve('ws'));",
  ].join('');
  const { stdout } = await execFileAsync(process.execPath, ['-e', resolver, client], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const resolvedEntry = await realpath(String(stdout).trim());
  const relativeEntry = path.relative(wsRoot, resolvedEntry);
  if (
    !relativeEntry
    || relativeEntry === '..'
    || relativeEntry.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeEntry)
  ) {
    throw new Error('Packaged POS client resolves ws outside the hashed runtime tree');
  }
  const entry = await describeFile(resolvedEntry, 'Resolved packaged POS ws entry');
  return {
    ...await describeWsTree(wsRoot, 'Packaged POS ws runtime tree'),
    resolvedEntry: relativeEntry.split(path.sep).join('/'),
    resolvedEntrySha256: entry.sha256,
  };
}

export function compiledGatewayRoot(posRoot) {
  return path.join(posRoot, COMPILED_GATEWAY_RELATIVE);
}

export function packagedAppRoot(posRoot) {
  return path.join(posRoot, PACKAGED_APP_RELATIVE);
}

export function compiledProvenancePath(posRoot) {
  return path.join(
    compiledGatewayRoot(posRoot),
    INVOICE_BRIDGE_E2E_PROVENANCE_FILENAME,
  );
}

export function packagedProvenancePath(posRoot) {
  return path.join(
    packagedAppRoot(posRoot),
    COMPILED_GATEWAY_RELATIVE,
    INVOICE_BRIDGE_E2E_PROVENANCE_FILENAME,
  );
}

export function packagedClientPath(posRoot) {
  return path.join(
    packagedAppRoot(posRoot),
    COMPILED_GATEWAY_RELATIVE,
    'client.js',
  );
}

async function describeGatewayModules(posRoot) {
  const compiledRoot = await assertCanonicalDirectory(
    compiledGatewayRoot(posRoot),
    'Compiled POS invoice bridge directory',
  );
  const packagedRoot = await assertCanonicalDirectory(
    path.join(packagedAppRoot(posRoot), COMPILED_GATEWAY_RELATIVE),
    'Packaged POS invoice bridge directory',
  );
  const modules = {};
  for (const filename of INVOICE_BRIDGE_E2E_GATEWAY_MODULES) {
    const compiled = await describeFile(
      path.join(compiledRoot, filename),
      `Compiled POS ${filename}`,
    );
    const packaged = await describeFile(
      path.join(packagedRoot, filename),
      `Packaged POS ${filename}`,
    );
    if (compiled.sha256 !== packaged.sha256 || compiled.bytes !== packaged.bytes) {
      throw new Error(`Packaged POS ${filename} does not match compiled output`);
    }
    modules[filename] = compiled;
  }
  return modules;
}

export async function freshCompileInvoiceBridgeGateway(posRootValue) {
  const posRoot = await canonicalPosRoot(posRootValue);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'zira-pos-gateway-compile-'));
  try {
    const outDir = path.join(tempRoot, 'out');
    const configPath = path.join(tempRoot, 'tsconfig.json');
    await writeFile(configPath, `${JSON.stringify({
      extends: path.join(posRoot, 'tsconfig.main.json'),
      compilerOptions: {
        rootDir: path.join(posRoot, 'src'),
        outDir,
        incremental: false,
        noEmitOnError: true,
      },
      files: INVOICE_BRIDGE_E2E_GATEWAY_SOURCES.map((filename) =>
        path.join(posRoot, 'src', 'main', 'invoice-gateway', filename)),
      include: [],
      exclude: [],
    }, null, 2)}\n`, 'utf8');
    const tscPath = await assertRegularCanonicalFile(
      path.join(posRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'Installed TypeScript compiler',
    );
    await execFileAsync(process.execPath, [tscPath, '-p', configPath, '--pretty', 'false'], {
      cwd: posRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const modules = {};
    const freshRoot = path.join(outDir, 'main', 'invoice-gateway');
    for (const filename of INVOICE_BRIDGE_E2E_GATEWAY_MODULES) {
      modules[filename] = await describeFile(
        path.join(freshRoot, filename),
        `Fresh-compiled POS ${filename}`,
      );
    }
    return modules;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertFreshGatewayModules(posRoot, gatewayModules, compileGateway) {
  const freshModules = await (compileGateway ?? freshCompileInvoiceBridgeGateway)(posRoot);
  for (const filename of INVOICE_BRIDGE_E2E_GATEWAY_MODULES) {
    if (
      freshModules?.[filename]?.sha256 !== gatewayModules[filename].sha256
      || freshModules?.[filename]?.bytes !== gatewayModules[filename].bytes
    ) {
      throw new Error(`POS ${filename} does not match a fresh compile from current source`);
    }
  }
}

async function collectProvenance(
  posRoot,
  git,
  buildStampOptions,
  compileGateway,
) {
  const rootFiles = await describeRootFiles(posRoot);
  const gatewaySources = await describeGatewaySources(posRoot);
  const buildStamp = await verifyCompiledBuildStamp(
    posRoot,
    git,
    rootFiles,
    gatewaySources,
    buildStampOptions,
  );
  const gatewayModules = await describeGatewayModules(posRoot);
  await assertFreshGatewayModules(posRoot, gatewayModules, compileGateway);
  const installedWs = await describeWsTree(
    path.join(posRoot, 'node_modules', 'ws'),
    'Installed POS ws package',
  );
  const runtimeWs = await describeRuntimeWs(posRoot);
  if (installedWs.version !== runtimeWs.version) {
    throw new Error('Packaged POS ws version does not match the installed dependency');
  }
  return {
    schemaVersion: INVOICE_BRIDGE_E2E_PROVENANCE_VERSION,
    kind: INVOICE_BRIDGE_E2E_PROVENANCE_KIND,
    git,
    buildInvocation: buildStamp.value,
    buildStampModule: buildStamp.module,
    rootFiles,
    gatewaySources,
    gatewayModules,
    ws: {
      installed: installedWs,
      runtime: runtimeWs,
    },
  };
}

export function serializeInvoiceBridgeE2eProvenance(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readIdenticalManifests(posRoot) {
  let compiledPath;
  let packagedPath;
  try {
    compiledPath = await assertRegularCanonicalFile(
      compiledProvenancePath(posRoot),
      'Compiled POS E2E provenance manifest',
    );
    packagedPath = await assertRegularCanonicalFile(
      packagedProvenancePath(posRoot),
      'Packaged POS E2E provenance manifest',
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Compiled and packaged POS E2E provenance manifests are required');
    }
    throw error;
  }
  const [compiled, packaged] = await Promise.all([
    readFile(compiledPath, 'utf8'),
    readFile(packagedPath, 'utf8'),
  ]);
  if (compiled !== packaged) {
    throw new Error('Compiled and packaged POS E2E provenance manifests differ');
  }
  return compiled;
}

export async function generateInvoiceBridgeE2eProvenance(options = {}) {
  const posRoot = await canonicalPosRoot(options.posRoot);
  const git = await readCleanGitIdentity(posRoot, {
    expectedPosCommit: options.expectedPosCommit,
    expectedPosTree: options.expectedPosTree,
  });
  const provenance = await collectProvenance(
    posRoot,
    git,
    { requireSource: true },
    options.compileGateway,
  );
  const contents = serializeInvoiceBridgeE2eProvenance(provenance);
  await writeFile(compiledProvenancePath(posRoot), contents, { encoding: 'utf8' });
  await writeFile(packagedProvenancePath(posRoot), contents, { encoding: 'utf8' });
  if (await readIdenticalManifests(posRoot) !== contents) {
    throw new Error('POS E2E provenance manifest write verification failed');
  }
  return provenance;
}

export async function verifyInvoiceBridgeE2eProvenance(options = {}) {
  const posRoot = await canonicalPosRoot(options.posRoot);
  if (options.expectedPosCommit === undefined) {
    throw new Error('Expected POS commit is required for provenance verification');
  }
  if (options.expectedPosTree === undefined) {
    throw new Error('Expected POS tree is required for provenance verification');
  }
  const git = await readCleanGitIdentity(posRoot, {
    expectedPosCommit: options.expectedPosCommit,
    expectedPosTree: options.expectedPosTree,
  });
  const actual = await readIdenticalManifests(posRoot);
  let manifest;
  try {
    manifest = JSON.parse(actual);
  } catch {
    throw new Error('POS E2E provenance manifest is invalid JSON');
  }
  const expected = serializeInvoiceBridgeE2eProvenance(
    await collectProvenance(posRoot, git, {
      expectedStamp: manifest?.buildInvocation,
    }, options.compileGateway),
  );
  if (actual !== expected) {
    throw new Error('POS E2E provenance manifest does not match current build inputs/artifacts');
  }
  const provenance = manifest;
  return {
    posRoot,
    commit: git.head,
    tree: git.tree,
    clientPath: await assertRegularCanonicalFile(
      packagedClientPath(posRoot),
      'Packaged POS invoice bridge client',
    ),
    tokenHelperPath: await assertRegularCanonicalFile(
      path.join(
        packagedAppRoot(posRoot),
        COMPILED_GATEWAY_RELATIVE,
        'token.js',
      ),
      'Packaged POS invoice bridge token helper',
    ),
    provenance,
  };
}
