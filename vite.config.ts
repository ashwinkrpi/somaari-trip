import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {defineConfig, type Plugin} from 'vite';

// Writes .br and .gz next to each text asset so the server never compresses static files at runtime
function precompress(): Plugin {
  let outDir = '';
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!/\.(js|css|html|svg|json|txt)$/.test(name)) continue;
        const file = path.join(outDir, name);
        const data = fs.readFileSync(file);
        if (data.length <= 1024) continue;
        fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }));
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(data, {level: 9}));
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), precompress()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
