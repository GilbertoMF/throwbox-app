import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.throwbox.app',
  appName: 'Throwbox',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    hostname: 'localhost:3000',
    allowNavigation: [
      'accounts.google.com',
      '*.google.com',
      '*.googleusercontent.com'
    ]
  },
  android: {
    overrideUserAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
  },
  plugins: {
    GoogleAuth: {
      scopes: ["profile", "email"],
      serverClientId: "569049899903-rb5qc608qpdnt8vkqv66dl4ctkdjvnfq.apps.googleusercontent.com",
      forceCodeForRefreshToken: true
    }
  }
};

export default config;
