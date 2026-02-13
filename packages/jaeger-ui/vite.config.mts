// Copyright (c) 2023 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable import/no-extraneous-dependencies */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const proxyConfig = {
  target: 'http://127.0.0.1:16686',
  secure: false,
  changeOrigin: true,
  ws: true,
  xfwd: true,
};

/**
 * Vite plugin to inject local UI config during development.
 * This mimics the behavior of the Go query-service which injects config into index.html.
 *
 * Supports two config file formats:
 * 1. jaeger-ui.config.js - JavaScript file that exports a config object (or function returning one)
 * 2. jaeger-ui.config.json - JSON file with config object
 *
 * The plugin only runs in development mode (npm start).
 *
 * Security note: These config files are local to the developer's machine and are
 * excluded from git via .gitignore. The content is injected into the HTML during
 * development only, similar to how the Go query-service injects config in production.
 */
let cachedConfig: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 30 * 1000; // 30 seconds

function jaegerUiConfigPlugin() {
  const jsConfigPath = path.resolve(__dirname, 'jaeger-ui.config.js');
  const jsonConfigPath = path.resolve(__dirname, 'jaeger-ui.config.json');

  return {
    name: 'jaeger-ui-config',
    configureServer(server: import('vite').ViteDevServer) {
      server.watcher.add([jsConfigPath, jsonConfigPath]);
      server.watcher.on('change', (changedPath: string) => {
        if (changedPath === jsConfigPath || changedPath === jsonConfigPath) {
          console.log(`[jaeger-ui-config] Config file changed: ${changedPath}. Reloading...`);
          server.ws.send({ type: 'full-reload', path: '*' });
        }
      });
    },
    transformIndexHtml: {
      order: 'pre' as const,
      async handler(html: string) {
        const now = Date.now();
        if (!cachedConfig || now - lastFetchTime > CACHE_DURATION) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1000);

          try {
            // Priority 1: User-specified single endpoint
            // Priority 2: Fallback to standard Jaeger endpoints if single endpoint fails
            const response = await fetch('http://127.0.0.1:16686/api/ui/config', {
              signal: controller.signal,
            }).catch(() => null);

            if (response?.ok) {
              const data = await response.json();
              cachedConfig = {
                uiConfig: data.uiConfig || null,
                storageCapabilities: data.storageCapabilities || null,
                version: data.version || null,
              };
            } else {
              // Standard fallback for community Jaeger versions
              const [configRes, capsRes, versionRes] = await Promise.all([
                fetch('http://127.0.0.1:16686/api/config', { signal: controller.signal }).catch(() => null),
                fetch('http://127.0.0.1:16686/api/capabilities', { signal: controller.signal }).catch(() => null),
                fetch('http://127.0.0.1:16686/api/version', { signal: controller.signal }).catch(() => null),
              ]);

              cachedConfig = {
                uiConfig: configRes?.ok ? await configRes.json() : null,
                storageCapabilities: capsRes?.ok ? await capsRes.json() : null,
                version: versionRes?.ok ? await versionRes.json() : null,
              };
            }
            lastFetchTime = now;
          } catch (err) {
            cachedConfig = { uiConfig: null, storageCapabilities: null, version: null };
          } finally {
            clearTimeout(timeout);
          }
        }

        const { uiConfig, storageCapabilities, version } = cachedConfig;

        // Inject capabilities and version (Backend-only)
        if (storageCapabilities) {
          html = html.replace(
            'const JAEGER_STORAGE_CAPABILITIES = DEFAULT_STORAGE_CAPABILITIES;',
            `const JAEGER_STORAGE_CAPABILITIES = ${JSON.stringify(storageCapabilities)};`
          );
        }
        if (version) {
          html = html.replace(
            'const JAEGER_VERSION = DEFAULT_VERSION;',
            `const JAEGER_VERSION = ${JSON.stringify(version)};`
          );
        }

        // Handle UI Config merge rules
        if (fs.existsSync(jsConfigPath)) {
          try {
            const jsContent = fs.readFileSync(jsConfigPath, 'utf-8');
            const uiConfigFn = `function UIConfig() { ${jsContent} }`;
            html = html.replace('// JAEGER_CONFIG_JS', uiConfigFn);
            console.log('[jaeger-ui-config] Source: Using jaeger-ui.config.js (full override)');
            return html;
          } catch (err) {
            console.error('[jaeger-ui-config] Error loading jaeger-ui.config.js:', err);
          }
        }

        let finalUiConfig = uiConfig;
        let source = uiConfig ? 'backend' : 'defaults';

        if (fs.existsSync(jsonConfigPath)) {
          try {
            const jsonContent = fs.readFileSync(jsonConfigPath, 'utf-8');
            const parsedJsonConfig = JSON.parse(jsonContent);
            finalUiConfig = { ...uiConfig, ...parsedJsonConfig };
            source = uiConfig ? 'backend + jaeger-ui.config.json' : 'jaeger-ui.config.json';
            console.log(`[jaeger-ui-config] Source: ${source}`);
          } catch (err) {
            console.error('[jaeger-ui-config] Error loading jaeger-ui.config.json:', err);
          }
        } else if (uiConfig) {
          console.log('[jaeger-ui-config] Source: backend');
        } else {
          console.log('[jaeger-ui-config] Source: defaults (backend unreachable)');
        }

        if (finalUiConfig) {
          html = html.replace(
            'const JAEGER_CONFIG = DEFAULT_CONFIG;',
            `const JAEGER_CONFIG = ${JSON.stringify(finalUiConfig)};`
          );
        }

        return html;
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __REACT_APP_GA_DEBUG__: JSON.stringify(process.env.REACT_APP_GA_DEBUG || ''),
    __REACT_APP_VSN_STATE__: JSON.stringify(process.env.REACT_APP_VSN_STATE || ''),
    __APP_ENVIRONMENT__: JSON.stringify(process.env.NODE_ENV || 'development'),
  },
  plugins: [
    jaegerUiConfigPlugin() as any,
    react({
      babel: {
        babelrc: true,
      },
    }) as any,
    legacy({
      targets: ['>0.5%', 'not dead', 'not ie <= 11', 'not op_mini all'],
    }) as any,
  ],
  css: {
    preprocessorOptions: {
      less: {
        math: 'always',
        javascriptEnabled: true,
      },
    },
  },
  server: {
    proxy: {
      // Proxy jaeger-query resource paths for local development.
      '/api': proxyConfig,
      '/analytics': proxyConfig,
      '/serviceedges': proxyConfig,
      '/qualitymetrics-v2': proxyConfig,
    },
  },
  base: './',
  build: {
    outDir: 'build',
    assetsDir: 'static',
    commonjsOptions: {
      // Ensure we transform modules that contain a mix of ES imports
      // and CommonJS require() calls to avoid stray require() calls in production.
      transformMixedEsModules: true,
    },
  },
  resolve: {
    alias: {
      // allow hot reload of Plexus code -- https://github.com/jaegertracing/jaeger-ui/pull/2089
      '@jaegertracing/plexus': path.resolve(__dirname, '../plexus/src'),
    },
  },
});
