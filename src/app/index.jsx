import { ConfigProvider } from 'antd';
import 'antd/dist/antd.css';
import series from 'async/series';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import i18nHttpApi from 'i18next-http-backend';
import React from 'react';
import ReactDOM from 'react-dom';
import { initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';

import settings from './config/settings';
import { controller } from './communication/socket-communication';
import { initialize } from './lib/gaEvent';
import log from './lib/log';
import user from './lib/user';
import reduxStore from './store';
import { machineStore } from './store/local-storage';
import './styles/app.styl';
import './styles/vendor.styl';
import workerManager from './lib/manager/workerManager';
import App from './ui/App';
import { formatTimeline as formatStartupTimeline, mark as startupMark, markAt as startupMarkAt } from '../startup-timeline';


// Marked here, at module scope, so the gap from navigation to the first line
// of app code (bundle download + parse) is visible in the table.
if (typeof performance !== 'undefined' && performance.timeOrigin) {
    startupMarkAt('renderer: document start', performance.timeOrigin);
}
startupMark('renderer: script eval');

function setupLog() {
    log.setLevel(settings.log.level);
}

async function setupI18next() {
    return new Promise((resolve) => {
        i18next
            .use(i18nHttpApi)
            .use(LanguageDetector)
            .use(initReactI18next)
            .init(settings.i18next, () => {
                resolve();
            });
    });
}

function setupWorkerManager() {
    workerManager.initPool();
}

async function setup() {
    log.info('Bootstrap');

    // Setup log level
    setupLog();

    // Setup i18n
    await setupI18next();
    startupMark('renderer: i18n ready');

    // Setup worker
    setupWorkerManager();

    log.info('Bootstrap finished.');
}

series([
    async (next) => {
        // setup
        await setup();
        next();
    },
    (next) => {
        const token = machineStore.get('session.token');
        user.signin({ token: token })
            .then(({ authenticated }) => {
                startupMark('renderer: signin done');
                if (authenticated) {
                    log.error('Create and establish a WebSocket connection');
                    controller.connect(() => {
                        startupMark('renderer: socket connected');
                        next();
                    });
                    return;
                }
                next();
            });
    },
], () => {
    log.info(`Launching Snapmaker Luban v${settings.version}...`);

    // Prevent browser from loading a drag-and-dropped file
    // http://stackoverflow.com/questions/6756583/prevent-browser-from-loading-a-drag-and-dropped-file
    window.addEventListener('dragover', (e) => {
        e = e || window.event;
        e.preventDefault();
    }, false);

    window.addEventListener('drop', (e) => {
        e = e || window.event;
        e.preventDefault();
    }, false);

    // Hide loading
    const loading = document.getElementById('loading');
    loading && loading.remove();

    // Change background color after loading complete
    const body = document.querySelector('body');
    body.style.backgroundColor = '#f8f8f8'; // sidebar background color

    const container = document.createElement('div');
    document.body.appendChild(container);
    const userId = machineStore.get('userId');
    initialize(userId);

    ReactDOM.render(
        <ConfigProvider autoInsertSpaceInButton={false}>
            <Provider store={reduxStore}>
                <App />
            </Provider>
        </ConfigProvider>,
        container,
        () => {
            startupMark('renderer: first paint');
            log.info(`
${formatStartupTimeline('Luban startup - renderer')}`);
        }
    );
});
