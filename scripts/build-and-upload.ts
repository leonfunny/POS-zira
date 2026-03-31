#!/usr/bin/env npx ts-node
/**
 * Build and Upload Script for Zira AI Print Agent
 *
 * This script:
 * 1. Builds the Windows EXE installer
 * 2. Uploads to Cloudflare R2
 * 3. Outputs the download URL
 *
 * Usage:
 *   npx ts-node scripts/build-and-upload.ts
 *   npx ts-node scripts/build-and-upload.ts --skip-build   # Upload only
 *   npx ts-node scripts/build-and-upload.ts --version 1.0.2  # Override version
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// R2 Configuration (from backend/.env)
const R2_CONFIG = {
  accountId: '34683e60b1c21e5610da5b65cf65f93f',
  accessKeyId: '948efa6e631e7525d5d66f1e67784c1f',
  secretAccessKey: 'f1cbc73f9b22aba78bf4804a75a422bc810c78271dc4f30c8fc4346d10cc80f9',
  bucketName: 'zira',
  publicUrl: 'https://img.zira.pl',
  endpoint: 'https://34683e60b1c21e5610da5b65cf65f93f.r2.cloudflarestorage.com',
};

// Parse command line args
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const versionArg = args.find((a) => a.startsWith('--version='));
const customVersion = versionArg ? versionArg.split('=')[1] : null;

// Get version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = customVersion || packageJson.version;

// Paths
const projectRoot = path.join(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');

console.log('========================================');
console.log('  Zira AI Print Agent - Build & Upload');
console.log('========================================');
console.log(`Version: ${version}`);
console.log(`Skip build: ${skipBuild}`);
console.log('');

async function main() {
  try {
    // Step 1: Build
    if (!skipBuild) {
      console.log('[1/3] Building Windows installer...');
      console.log('      This may take several minutes...\n');

      execSync('npm run build', {
        cwd: projectRoot,
        stdio: 'inherit',
      });

      execSync('npm run dist:win', {
        cwd: projectRoot,
        stdio: 'inherit',
      });

      console.log('\n[1/3] Build completed!\n');
    } else {
      console.log('[1/3] Skipping build (--skip-build)\n');
    }

    // Step 2: Find the installer file
    console.log('[2/3] Looking for installer file...');

    // electron-builder generates files like "Zira AI Setup 1.0.1.exe"
    const files = fs.readdirSync(releaseDir);
    const installerFile = files.find(
      (f) => f.endsWith('.exe') && (f.includes('Setup') || f.includes('setup'))
    );

    if (!installerFile) {
      console.error('ERROR: No installer file found in release/ directory');
      console.error('Files in release/:', files);
      process.exit(1);
    }

    const installerPath = path.join(releaseDir, installerFile);
    const fileStats = fs.statSync(installerPath);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

    console.log(`      Found: ${installerFile}`);
    console.log(`      Size: ${fileSizeMB} MB\n`);

    // Step 3: Upload to R2
    console.log('[3/3] Uploading to Cloudflare R2...');

    // Two uploads: fixed "latest" link + versioned archive
    const latestFilename = 'Zira_AI_Setup.exe';
    const versionedFilename = `Zira_AI_Setup_${version}.exe`;
    const latestKey = `downloads/${latestFilename}`;
    const versionedKey = `downloads/${versionedFilename}`;
    const downloadUrl = `${R2_CONFIG.publicUrl}/${latestKey}`;
    const versionedUrl = `${R2_CONFIG.publicUrl}/${versionedKey}`;

    // Use AWS SDK to upload
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: R2_CONFIG.endpoint,
      credentials: {
        accessKeyId: R2_CONFIG.accessKeyId,
        secretAccessKey: R2_CONFIG.secretAccessKey,
      },
    });

    const fileBuffer = fs.readFileSync(installerPath);

    // Upload as latest (fixed link used by dashboard)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: latestKey,
        Body: fileBuffer,
        ContentType: 'application/octet-stream',
        ContentDisposition: `attachment; filename="${latestFilename}"`,
        CacheControl: 'public, max-age=3600', // 1 hour cache (so updates propagate faster)
      })
    );
    console.log(`      Uploaded: ${latestKey}`);

    // Upload versioned copy (archive/rollback)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: versionedKey,
        Body: fileBuffer,
        ContentType: 'application/octet-stream',
        ContentDisposition: `attachment; filename="${versionedFilename}"`,
        CacheControl: 'public, max-age=31536000', // 1 year cache (immutable)
      })
    );
    console.log(`      Uploaded: ${versionedKey}`);

    // Upload latest.yml (auto-update manifest)
    const yamlPath = path.join(releaseDir, 'latest.yml');
    if (fs.existsSync(yamlPath)) {
      let yamlContent = fs.readFileSync(yamlPath, 'utf-8');

      // Rewrite the url in YAML to point to the versioned filename on R2
      // electron-builder generates "url: Zira AI Setup 1.0.3.exe" — we need the R2 filename
      yamlContent = yamlContent.replace(
        /url: .+\.exe/,
        `url: ${versionedFilename}`
      );

      await s3Client.send(
        new PutObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: 'downloads/latest.yml',
          Body: yamlContent,
          ContentType: 'text/yaml',
          CacheControl: 'public, max-age=300', // 5 min cache (so updates propagate quickly)
        })
      );
      console.log(`      Uploaded: downloads/latest.yml`);
    } else {
      console.warn('      WARNING: latest.yml not found in release/ — auto-update will not work');
    }
    console.log('');

    // Output results
    console.log('========================================');
    console.log('  Upload Complete!');
    console.log('========================================');
    console.log('');
    console.log(`Latest (dashboard): ${downloadUrl}`);
    console.log(`Archive (v${version}): ${versionedUrl}`);
    console.log('');

    // Also write to a file for easy reference
    const resultFile = path.join(projectRoot, 'release', 'LATEST_BUILD.txt');
    fs.writeFileSync(
      resultFile,
      `Version: ${version}
Latest: ${downloadUrl}
Archive: ${versionedUrl}
Size: ${fileSizeMB} MB
Built: ${new Date().toISOString()}
`
    );
    console.log(`Build info saved to: ${resultFile}`);
  } catch (error) {
    console.error('\nERROR:', error);
    process.exit(1);
  }
}

main();
