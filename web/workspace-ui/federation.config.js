const { withNativeFederation, shareAll } = require('@angular-architects/native-federation/config');

module.exports = withNativeFederation({
  name: 'workspace-ui',

  // what the shell may load: the project panels, and the bell that follows the person around the page
  exposes: {
    './Feed': './src/app/feed.ts',
    './Issues': './src/app/issues.ts',
    './Chat': './src/app/chat.ts',
    './Notifications': './src/app/notifications.ts',
    './People': './src/app/people.ts',
    './Quick': './src/app/quick.ts',
  },

  shared: {
    ...shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }),
  },

  skip: [
    'rxjs/ajax',
    'rxjs/fetch',
    'rxjs/testing',
    'rxjs/webSocket',
    // Add further packages you don't need at runtime
  ],

  // Please read our FAQ about sharing libs:
  // https://shorturl.at/jmzH0

  features: {
    // New feature for more performance and avoiding
    // issues with node libs. Comment this out to
    // get the traditional behavior:
    ignoreUnusedDeps: true,
  },
});
