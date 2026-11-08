// Build with clang++ on PATH, or set CANVAS_CLANG to a WASI SDK clang++.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const path = file => fileURLToPath(new URL(file, import.meta.url));
const result = spawnSync(process.env.CANVAS_CLANG || 'clang++', [
    '--target=wasm32', '-std=c++17', '-O3', '-msimd128', '-ffp-contract=off',
    '-ffreestanding', '-fno-exceptions', '-fPIC', '-nostdlib',
    '-Wl,--shared', '-Wl,--experimental-pic', '-Wl,--no-entry', '-Wl,--export=blend_normal_rgba',
    '-Wl,--export=gaussian_rgba',
    path('./canvas_filter.cpp'), '-o', path('../static/canvas_editor/filter.wasm')
], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
