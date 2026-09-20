import { strict as assert } from 'assert';

import { CameraCandidate, isSnapshotUrl, matchCameraDevice, selectionInvalidatesModel } from '../cameraSelection';

// The Ubuntu box as it actually is: the toolhead camera and a second one,
// both listed under stable by-id symlinks, both perfectly capable of
// returning a frame that looks fine and measures wrong.
const TOOLHEAD: CameraCandidate = {
    entry: '/dev/v4l/by-id/usb-Sonix_Technology_Co.__Ltd._USB_2.0_Camera-video-index0 (USB 2.0 Camera)',
    aliases: [
        '/dev/v4l/by-id/usb-Sonix_Technology_Co.__Ltd._USB_2.0_Camera-video-index0',
        'USB 2.0 Camera',
        '/dev/video2',
    ],
};
const SECOND: CameraCandidate = {
    entry: '/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920-video-index0 (HD Pro Webcam C920)',
    aliases: ['/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920-video-index0', 'HD Pro Webcam C920', '/dev/video0'],
};
const BOTH = [TOOLHEAD, SECOND];

export const tests: Array<[string, () => void]> = [
    ['the full entry resolves to itself', () => {
        const match = matchCameraDevice(TOOLHEAD.entry, BOTH);
        assert.equal(match.ok, true);
        assert.equal(match.entry, TOOLHEAD.entry);
        assert.equal(match.matchedOn, 'entry');
    }],

    ['a by-id path resolves to the entry it names', () => {
        const match = matchCameraDevice('/dev/v4l/by-id/usb-Sonix_Technology_Co.__Ltd._USB_2.0_Camera-video-index0', BOTH);
        assert.equal(match.ok, true);
        assert.equal(match.entry, TOOLHEAD.entry);
        assert.equal(match.matchedOn, 'alias');
    }],

    ['the /dev/videoN the symlink resolves to is the same camera', () => {
        const match = matchCameraDevice('/dev/video2', BOTH);
        assert.equal(match.ok, true);
        assert.equal(match.entry, TOOLHEAD.entry);
    }],

    ['a friendly name resolves case-insensitively', () => {
        const match = matchCameraDevice('usb 2.0 camera', BOTH);
        assert.equal(match.ok, true);
        assert.equal(match.entry, TOOLHEAD.entry);
    }],

    ['a substring that names one camera resolves', () => {
        const match = matchCameraDevice('C920', BOTH);
        assert.equal(match.ok, true);
        assert.equal(match.entry, SECOND.entry);
        assert.equal(match.matchedOn, 'substring');
    }],

    ['a substring that names both cameras is refused, not guessed', () => {
        const match = matchCameraDevice('by-id', BOTH);
        assert.equal(match.ok, false);
        assert.equal(match.entry, null);
        assert.match(match.reason, /matches 2 cameras/);
        // Both must be named, or the caller cannot make the next try right.
        assert.match(match.reason, /Sonix/);
        assert.match(match.reason, /C920/);
    }],

    ['an index is refused: device numbering does not survive a replug', () => {
        const match = matchCameraDevice('0', BOTH);
        assert.equal(match.ok, false);
        assert.match(match.reason, /replug/);
    }],

    ['a camera that is not attached is refused with the ones that are', () => {
        const match = matchCameraDevice('/dev/video9', BOTH);
        assert.equal(match.ok, false);
        assert.match(match.reason, /No attached camera matches/);
        assert.match(match.reason, /C920/);
    }],

    ['an empty device names the attached cameras rather than defaulting', () => {
        const match = matchCameraDevice('   ', BOTH);
        assert.equal(match.ok, false);
        assert.match(match.reason, /Sonix/);
    }],

    ['with one camera attached a loose substring still resolves', () => {
        const match = matchCameraDevice('Sonix', [TOOLHEAD]);
        assert.equal(match.ok, true);
        assert.equal(match.entry, TOOLHEAD.entry);
    }],

    ['no cameras attached says so instead of resolving', () => {
        const match = matchCameraDevice('/dev/video0', []);
        assert.equal(match.ok, false);
        assert.match(match.reason, /none attached/);
    }],

    ['a snapshot URL is recognised as its own kind of source', () => {
        assert.equal(isSnapshotUrl('http://192.168.1.153:8080/shot.jpg'), true);
        assert.equal(isSnapshotUrl('HTTPS://cam.local/snapshot'), true);
        assert.equal(isSnapshotUrl('/dev/video0'), false);
        assert.equal(isSnapshotUrl('USB 2.0 Camera'), false);
    }],

    ['a URL selects as a candidate like any other camera', () => {
        const url = { entry: 'http://192.168.1.153:8080/shot.jpg', aliases: [] };
        const match = matchCameraDevice('http://192.168.1.153:8080/shot.jpg', [url, TOOLHEAD]);
        assert.equal(match.ok, true);
        assert.equal(match.entry, url.entry);
    }],

    ['changing camera invalidates the solved model; re-pinning the same one does not', () => {
        assert.equal(selectionInvalidatesModel(SECOND.entry, TOOLHEAD.entry), true);
        assert.equal(selectionInvalidatesModel(TOOLHEAD.entry, TOOLHEAD.entry), false);
        // Nothing was pinned before, so there is no earlier camera a model
        // could have been solved for through this selection.
        assert.equal(selectionInvalidatesModel(null, TOOLHEAD.entry), false);
    }],
];
