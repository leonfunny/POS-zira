# Release Guide - Zira AI Print Agent

## Overview

This guide covers how to build, upload, and release new versions of the Zira AI Print Agent Windows application.

## Prerequisites

- Node.js 18+
- npm packages installed (`npm install`)
- Windows environment (for building Windows EXE) OR Wine on Linux

## Quick Release

```bash
cd /var/www/enail/print-agent

# 1. Bump version (patch: 1.0.1 -> 1.0.2)
./scripts/bump-version.sh patch

# 2. Build and upload
./scripts/build-and-upload.sh

# 3. Deploy dashboard to show new download link
cd /var/www/enail/frontend && npm run build && pm2 restart enail-frontend
```

## Scripts

### `./scripts/bump-version.sh`

Updates the version number in package.json and dashboard download link.

```bash
# Patch version (1.0.1 -> 1.0.2)
./scripts/bump-version.sh patch

# Minor version (1.0.1 -> 1.1.0)
./scripts/bump-version.sh minor

# Major version (1.0.1 -> 2.0.0)
./scripts/bump-version.sh major

# Specific version
./scripts/bump-version.sh 2.0.0
```

### `./scripts/build-and-upload.sh`

Builds the Windows installer and uploads to Cloudflare R2.

```bash
# Full build + upload
./scripts/build-and-upload.sh

# Upload only (skip build, useful for re-uploading)
./scripts/build-and-upload.sh --skip-build

# Custom version (override package.json)
./scripts/build-and-upload.sh --version=1.0.2
```

## Manual Steps

### 1. Build Only

```bash
npm run build          # Compile TypeScript
npm run dist:win       # Build Windows installer
```

Output: `release/Zira AI Setup X.X.X.exe`

### 2. Upload to R2 Manually

Using AWS CLI (configure with R2 credentials first):

```bash
aws s3 cp "release/Zira AI Setup 1.0.1.exe" \
    s3://zira/downloads/eNail_Print_Agent_Setup_1.0.1.exe \
    --endpoint-url https://34683e60b1c21e5610da5b65cf65f93f.r2.cloudflarestorage.com
```

### 3. Update Dashboard Link

Edit file: `/var/www/enail/frontend/src/app/app/settings/print-agent/page.tsx`

Find line ~528 and update the URL:

```tsx
href="https://img.zira.pl/downloads/eNail_Print_Agent_Setup_1.0.2.exe"
```

### 4. Deploy Dashboard

```bash
cd /var/www/enail/frontend
npm run build
pm2 restart enail-frontend
```

## R2 Storage Configuration

| Setting | Value |
|---------|-------|
| Bucket | zira |
| Region | auto |
| Public URL | https://img.zira.pl |
| Endpoint | https://34683e60b1c21e5610da5b65cf65f93f.r2.cloudflarestorage.com |
| Folder | downloads/ |

## Download URLs

| Version | URL |
|---------|-----|
| Latest | https://img.zira.pl/downloads/eNail_Print_Agent_Setup_1.0.1.exe |
| Google Mirror | https://storage.googleapis.com/image_data_learning/eNail%20Print%20Agent%20Setup%201.0.1.exe |

## Troubleshooting

### Build fails on Linux

electron-builder requires Wine to build Windows executables on Linux:

```bash
# Ubuntu/Debian
sudo apt install wine wine64

# Or build on Windows machine/CI
```

### Upload fails

Check R2 credentials in `/var/www/enail/backend/.env`:

```env
R2_ACCOUNT_ID=xxxxx
R2_ACCESS_KEY_ID=xxxxx
R2_SECRET_ACCESS_KEY=xxxxx
R2_BUCKET_NAME=zira
R2_PUBLIC_URL=https://img.zira.pl
```

### Old version still shows

Clear browser cache or wait for CDN cache to expire (24 hours).

## Changelog

### v1.0.1
- Initial release with invoicing module
- NIP/VAT lookup integration
- Thermal and A4 printing support

### v1.0.0
- First stable release
