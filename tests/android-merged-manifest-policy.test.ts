import { describe, expect, test } from 'vitest';
import { verifyMergedManifest } from '../scripts/verify-android-manifests.mjs';

const internet = '<uses-permission android:name="android.permission.INTERNET" />';
const fixture = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
  package="com.ziraai.posdiagnostics.dev" android:versionName="1.0.26" android:versionCode="9081">
  ${internet}
  <permission android:name="com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" android:protectionLevel="signature" />
  <uses-permission android:name="com.ziraai.posdiagnostics.dev.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />
  <application android:allowBackup="false" android:fullBackupContent="@xml/backup_rules"
    android:dataExtractionRules="@xml/data_extraction_rules" android:usesCleartextTraffic="false">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
    <provider android:name="androidx.startup.InitializationProvider" android:exported="false" />
  </application>
</manifest>`;
const check = (xml = fixture, variant = 'debug') => verifyMergedManifest(variant, xml, {
  productVersion: '1.0.26', buildNumber: '9081',
});

describe('actual merged Android manifest gate', () => {
  test.each(['debug', 'release'])('accepts HTTPS-capable %s manifest', variant => {
    expect(check(fixture, variant)).toEqual([]);
  });
  test('rejects missing permission, including permission text hidden in a comment', () => {
    expect(check(fixture.replace(internet, ''))).toContain('debug: exactly one INTERNET permission is required');
    expect(check(fixture.replace(internet, `<!-- ${internet} -->`))).toContain('debug: exactly one INTERNET permission is required');
  });
  test('rejects duplicate or SDK-capped internet', () => {
    expect(check(fixture.replace(internet, internet + internet))).toContain('debug: exactly one INTERNET permission is required');
    expect(check(fixture.replace(internet, internet.replace(' />', ' android:maxSdkVersion="28" />')))).toContain('debug: INTERNET permission must not be SDK-capped');
  });
  test.each([
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.CAMERA"></uses-permission>',
    '<uses-permission-sdk-23 android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
  ])('rejects unknown permission form %s', extra => {
    expect(check(fixture.replace(internet, internet + extra)).some((error: string) => error.includes('unexpected uses-permission'))).toBe(true);
  });
  test.each([
    ['android:allowBackup="false"', 'android:allowBackup="true"', 'allowBackup is not false'],
    ['android:usesCleartextTraffic="false"', 'android:usesCleartextTraffic="true"', 'usesCleartextTraffic is not false'],
    ['<application ', '<application android:debuggable="true" ', 'debuggable=true'],
    ['android:protectionLevel="signature"', 'android:protectionLevel="normal"', 'unexpected permission declaration'],
    ['android:name="androidx.startup.InitializationProvider"', 'android:name="androidx.core.content.FileProvider"', 'FileProvider surface present'],
    ['android:name="androidx.startup.InitializationProvider"', 'android:name="attacker.Provider"', 'unexpected provider'],
    ['android:name="androidx.startup.InitializationProvider" android:exported="false"', 'android:name="androidx.startup.InitializationProvider" android:exported="true"', 'exported non-launcher'],
    ['package="com.ziraai.posdiagnostics.dev"', 'package="com.ziraai.production"', 'package does not match the development identity'],
    ['android:versionCode="9081"', 'android:versionCode="1"', 'versionCode does not match Android build number'],
    ['android:versionName="1.0.26"', 'android:versionName="0.0.1"', 'versionName does not match package product version'],
  ])('retains guard %s', (from, to, message) => {
    expect(check(fixture.replace(from, to)).some((error: string) => error.includes(message))).toBe(true);
  });
});
