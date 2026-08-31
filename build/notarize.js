const { notarize } = require('@electron/notarize');

module.exports = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;

    if (electronPlatformName !== 'darwin') {
        return;
    }

    if (!process.env.CI) {
        return;
    }

    // Forks build unsigned: skip notarization when the Apple credentials are
    // not configured instead of crashing the whole package step.
    if (!process.env.APPLEID || !process.env.APPLEIDPASS || !process.env.TEAMID) {
        console.log('Skipping notarization: Apple signing credentials are not configured.');
        return;
    }

    // Notarize only when running on Travis-CI and has a tag.
    console.log('Notarizing application...');

    const appName = context.packager.appInfo.productFilename;

    const teamId = process.env.TEAMID;;
    const appleId = process.env.APPLEID;
    const appleIdPassword = process.env.APPLEIDPASS;

    await notarize({
        appPath: `${appOutDir}/${appName}.app`,
        appleId,
        appleIdPassword,
        teamId,
    });
};
