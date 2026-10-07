import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
type Asset = 'index.js' | 'worker.js';
const hashes: Record<Asset, string> = {
  'index.js': 'f8a476ccf771d686ab62d85ae80aa821a38e22eefef77091b5c43315f1eaf7ac',
  'worker.js': '7af23a19c9fcde28e0b57d0fba469aeab4afaa0fdd7a1831b83546b64a6736ed',
};
const cache = new Map<Asset, string>();
function replace(source: string, before: string, after: string, expected = 1): string {
  if (source.split(before).length - 1 !== expected) throw Error('Pinned Prismarine viewer compatibility anchor changed');
  return source.split(before).join(after);
}

/** Explicit, fingerprint-gated adaptations of the MIT-licensed 1.33.0 bundles.
 * Never edits node_modules or commits generated bundles. See READONLY-OBSERVER.
 */
export function viewerAsset(name: Asset): string {
  const cached = cache.get(name); if (cached) return cached;
  const filename = join(dirname(require.resolve('prismarine-viewer/package.json')), 'public', name);
  let source = readFileSync(filename, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== hashes[name]) throw Error('Unsupported Prismarine viewer bundle; review compatibility before enabling observation');
  if (name === 'index.js') {
    // Vanilla 1.21.1 height envelope. Workers discard sections outside each
    // column's actual minY/worldHeight (Nether/End remain 0..255).
    source = replace(source, 'for(let i=0;i<256;i+=16)', 'for(let i=-64;i<320;i+=16)', 2);
    source = replace(source, 't.y>0&&s&&(', 's&&(');
    source = replace(source, 'WorldRenderer:class{constructor(t,e=4)', 'WorldRenderer:class{constructor(t,e=1)');
    source = replace(source, 'let s=!0;const l=new THREE.WebGLRenderer;',
      'o.on("disconnect",()=>window.dispatchEvent(new CustomEvent("observer-stream-state",{detail:"disconnected"})));o.on("connect_error",()=>window.dispatchEvent(new CustomEvent("observer-stream-state",{detail:"disconnected"})));o.on("connect",()=>window.dispatchEvent(new CustomEvent("observer-stream-state",{detail:"connected"})));let s=!0;const l=new THREE.WebGLRenderer;');
  } else {
    source = replace(source, 'i.sections[Math.floor(a/16)]', 'i.sections[Math.floor((a-(i.minY??0))/16)]');
    source = replace(source, 'l.sections[Math.floor(n/16)]', 'l.sections[Math.floor((n-(l.minY??0))/16)]');
    source = replace(source, 'if(g.position.y<0)continue;', '');
    source = replace(source, 'if(n.position.y<0)continue', '');
  }
  cache.set(name, source); return source;
}
