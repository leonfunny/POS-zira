import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ziraai.posdiagnostics.dev',
  appName: 'Zira POS Diagnostics Dev',
  webDir: 'dist/android-web',
  loggingBehavior: 'none',
  android: {
    path: 'android-pos',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    includePlugins: [],
  },
  cordova: {
    accessOrigins: [],
  },
};

export default config;
