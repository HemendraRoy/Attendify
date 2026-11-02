const fs = require('fs');
const path = require('path');

const targetFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-webview',
  'android',
  'src',
  'main',
  'java',
  'com',
  'reactnativecommunity',
  'webview',
  'RNCWebViewManagerImpl.kt'
);

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  if (content.includes('webView.loadUrl(args.getString(0))')) {
    content = content.replace(
      'webView.loadUrl(args.getString(0))',
      'webView.loadUrl(args.getString(0) ?: "")'
    );
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[Attendify] Successfully patched RNCWebViewManagerImpl.kt for Kotlin 2.1 strict nullability.');
  }
}
