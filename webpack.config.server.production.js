const crypto = require('crypto');
const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const babelConfig = require('./babel.config');
const pkg = require('./package.json');

const NODE_MODULES = path.resolve(__dirname, 'node_modules');

// Bundle dependencies into the server bundle instead of externalizing all of
// node_modules: a cold start used to crawl thousands of small files (each
// scanned by antivirus on first open, ~10s+ after a rebuild or reboot before
// the backend answered), whereas one bundle is a single read. Only packages
// that cannot live inside a bundle stay external: native addons, packages
// that spawn or load sibling binaries/assets out of their own package
// directory, and template engines resolved by name at runtime.
const KEEP_EXTERNAL = [
    'serialport', // native (@serialport/bindings-cpp)
    'font-scanner', // native
    'lzma-native', // native
    '@snapmaker/snapmaker-lunar', // spawns LunarTPP binaries from its package dir
    'snapmaker-luban-engine', // spawns CuraEngine binaries from its package dir
    'opencv-wasm', // loads .wasm from its package dir
    'consolidate', // requires template engines by name at runtime
    'hogan.js', // loaded dynamically by consolidate
    'formidable', // constructor requires its plugin files from its package dir
    'errorhandler', // reads its stylesheet from its package dir
    'socket.io', // serveClient reads the client bundle from its package dir
];
const externals = [
    (context, request, callback) => {
        const external = request.startsWith('@serialport/')
            || KEEP_EXTERNAL.some((mod) => request === mod || request.startsWith(`${mod}/`));
        if (external) {
            return callback(null, `commonjs ${request}`);
        }
        return callback();
    },
];

// Use publicPath for production
// const payload = pkg.version;
const publicPath = (function calculatePublicPath(payload) {
    const algorithm = 'sha1';
    const buf = String(payload);
    const hash = crypto.createHash(algorithm).update(buf).digest('hex');
    return `/${hash.substr(0, 8)}/`; // 8 digits
}(pkg.version));

module.exports = {
    mode: 'production',
    target: 'node',
    context: path.resolve(__dirname, 'src/server'),
    resolve: {
        modules: ['node_modules'],
        extensions: ['.js', '.json', '.jsx', '.ts']
    },
    entry: {
        index: './index.js'
    },
    output: {
        path: path.resolve(__dirname, 'dist/Luban/src/server'),
        filename: '[name].js',
        libraryTarget: 'commonjs2'
    },
    optimization: {
        minimize: true,
        minimizer: [new TerserPlugin()],
    },
    plugins: [
        new webpack.DefinePlugin({
            'global.PUBLIC_PATH': JSON.stringify(publicPath)
        })
    ],
    module: {
        rules: [
            {
                test: /\.worker\.(j|t)s$/,
                loader: 'worker-loader',
                options: {
                    filename: '[name].js',
                },
            },
            {
                test: /\.ts$/,
                loader: 'ts-loader',
                options: {
                    transpileOnly: true
                }
            },
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                loader: 'babel-loader',
                options: babelConfig
            }
        ]
    },
    externals: externals,
    resolveLoader: {
        modules: [NODE_MODULES]
    },
    node: {
        console: true,
        global: true,
        process: true,
        Buffer: true,
        __filename: true, // Use relative path
        __dirname: true, // Use relative path
        setImmediate: true
    }
};
