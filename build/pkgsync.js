#!/usr/bin/env node

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const findImports = require('find-imports');

// Copy necessary properties from 'package.json' to 'src/package.json'
const pkg = require('../package.json');
const pkgApp = require('../src/package.json');

// Only the main process ships unbundled (src/main.js, src/electron-app/*,
// src/server-cli.js...), so only its imports need installing into the
// packaged app. The server's dependencies are compiled into its webpack
// bundle, except the keep-external list below — mirror of KEEP_EXTERNAL in
// webpack.config.server.production.js.
const files = [
    'src/*.{ts,js}',
    'src/electron-app/**/*.{ts,js}',
];
const serverExternals = [
    'serialport',
    'font-scanner',
    '@snapmaker/snapmaker-lunar',
    'snapmaker-luban-engine',
    'opencv-wasm',
    'consolidate',
    'hogan.js',
    'errorhandler',
    'socket.io',
];
const deps = [
    '@babel/runtime', // 'babel-runtime' is required for electron app
    'debug', // 'debug' is required for electron app
    '@electron/remote', // '@electron/remote/main' is required
    '@sentry/electron',
    // Lazy require()s inside functions in src/main.js, invisible to
    // findImports' top-level import scan:
    'electron-updater',
    'node-fetch',
].concat(serverExternals).concat(findImports(files, { flatten: true })).sort();

pkgApp.name = pkg.name;
pkgApp.version = pkg.version;
pkgApp.homepage = pkg.homepage;
pkgApp.author = pkg.author;
pkgApp.license = pkg.license;
pkgApp.repository = pkg.repository;

// Copy only Node.js dependencies to application package.json
pkgApp.dependencies = _.pick(pkg.dependencies, deps);
// Runtime externals of the server bundle whose former parents (superagent,
// node-fetch) are now bundled, so they are not root dependencies: pin them
// to the versions the parents resolve today.
pkgApp.dependencies.formidable = '2.1.2';
pkgApp.dependencies.encoding = '0.1.13';
pkgApp.config = pkg.config;

const target = path.resolve(__dirname, '../src/package.json');
const content = JSON.stringify(pkgApp, null, 2);
fs.writeFileSync(target, `${content}\n`, 'utf8');
