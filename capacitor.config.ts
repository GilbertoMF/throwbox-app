import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.throwbox.app',
  appName: 'Throwbox',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    hostname: 'localhost'
  },
  android: {
    overrideUserAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
  }
};

export default config;
