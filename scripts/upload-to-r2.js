#!/usr/bin/env node
/**
 * Upload Zira AI Print Agent to Cloudflare R2
 *
 * Usage:
 *   node scripts/upload-to-r2.js
 */

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// R2 Configuration
const R2_CONFIG = {
  accountId: '34683e60b1c21e5610da5b65cf65f93f',
  accessKeyId: '948efa6e631e7525d5d66f1e67784c1f',
  secretAccessKey: 'f1cbc73f9b22aba78bf4804a75a422bc810c78271dc4f30c8fc4346d10cc80f9',
  bucketName: 'zira',
  publicUrl: 'https://img.zira.pl',
  endpoint: 'https://34683e60b1c21e5610da5b65cf65f93f.r2.cloudflarestorage.com',
};

// Get version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = packageJson.version;

// Paths
const projectRoot = path.join(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');

async function main() {
  console.log('========================================');
  console.log('  Zira AI Print Agent - Upload to R2');
  console.log('========================================');
  console.log(`Version: ${version}`);
  console.log('');

  try {
    // Find the installer file
    console.log('[1/2] Looking for installer file...');

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
    console.log(`      Size: ${fileSizeMB} MB`);
    console.log('');

    // Upload to R2
    console.log('[2/2] Uploading to Cloudflare R2...');

    const latestFilename = 'Zira_AI_Setup.exe';
    const versionedFilename = `Zira_AI_Setup_${version}.exe`;
    const latestKey = `downloads/${latestFilename}`;
    const versionedKey = `downloads/${versionedFilename}`;
    const downloadUrl = `${R2_CONFIG.publicUrl}/${latestKey}`;
    const versionedUrl = `${R2_CONFIG.publicUrl}/${versionedKey}`;

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
        CacheControl: 'public, max-age=3600',
      })
    );
    console.log(`      Uploaded: ${latestKey}`);

    // Upload versioned copy (archive)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: versionedKey,
        Body: fileBuffer,
        ContentType: 'application/octet-stream',
        ContentDisposition: `attachment; filename="${versionedFilename}"`,
        CacheControl: 'public, max-age=31536000',
      })
    );
    console.log(`      Uploaded: ${versionedKey}`);
    console.log('');

    // Output results
    console.log('========================================');
    console.log('  Upload Complete!');
    console.log('========================================');
    console.log('');
    console.log(`Latest (dashboard): ${downloadUrl}`);
    console.log(`Archive (v${version}): ${versionedUrl}`);
    console.log('');

    // Write result file
    const resultFile = path.join(releaseDir, 'LATEST_BUILD.txt');
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
    console.error('\nERROR:', error.message);
    process.exit(1);
  }
}

main();
