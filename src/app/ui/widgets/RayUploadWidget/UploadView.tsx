import classNames from 'classnames';
import { includes } from 'lodash';
import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { WorkflowStatus } from '@snapmaker/luban-platform';
import controller from '../../../communication/socket-communication';
import SocketEvent from '../../../communication/socket-events';
import { JobOffsetMode } from '../../../constants/coordinate';
import { RootState } from '../../../flux/index.def';
import gcodeActions from '../../../flux/workspace/actions-gcode';
import { GCodeFileMetadata } from '../../../flux/workspace/types';
import i18n from '../../../lib/i18n';
import log from '../../../lib/log';
import { Button } from '../../components/Buttons';
import modalSmallHOC, { ModalSmallHOC } from '../../components/Modal/modal-small';
import { getRunBoundaryCode } from '../RaySetOriginWidget/SetOriginView';
import styles from './styles.styl';

export type LoadGcodeOptions = {
    renderImmediately?: boolean;
};

enum UploadFileModalType {
    None,
    Progress,
    Compressing,
    Decompressing,
}

const UploadView: React.FC = () => {
    const isConnected = useSelector((state: RootState) => state.workspace.isConnected);
    const setupCoordinateMethod = useSelector((state: RootState) => state.workspace.setupCoordinateMethod);

    const workflowStatus = useSelector((state: RootState) => state.workspace.workflowStatus);
    // const activeGcodeFile = useSelector((state: RootState) => state.workspace.activeGcodeFile);

    const isWorking = includes([
        WorkflowStatus.Running, WorkflowStatus.Pausing, WorkflowStatus.Paused, WorkflowStatus.Stopping, WorkflowStatus.Resuming
    ], workflowStatus);

    const jobOffsetMode: JobOffsetMode = useSelector((state: RootState) => state.laser.jobOffsetMode);

    const gcodeFile = useSelector((state: RootState) => state.workspace.gcodeFile);

    const [isUploading, setIsUploading] = useState(false);
    const [fileUploadProgress, setFileUploadProgress] = useState(0);
    const [fileUploadIsCompressing, setFileUploadIsCompressing] = useState(false);
    const [fileUploadIsDecompressing, setFileUploadIsDecompressing] = useState(false);

    useEffect(() => {
        const onProgress = ({ progress }) => {
            if (isUploading) {
                setFileUploadProgress(progress);
                setFileUploadIsCompressing(false);
                setFileUploadIsDecompressing(false);
            }
        };
        const onCompressing = () => {
            if (isUploading) {
                setFileUploadProgress(0);
                setFileUploadIsCompressing(true);
                setFileUploadIsDecompressing(false);
            }
        };
        const onDecompressing = () => {
            if (isUploading) {
                setFileUploadProgress(0);
                setFileUploadIsCompressing(false);
                setFileUploadIsDecompressing(true);
            }
        };

        controller.on(SocketEvent.UploadFileProgress, onProgress);
        controller.on(SocketEvent.UploadFileCompressing, onCompressing);
        controller.on(SocketEvent.UploadFileDecompressing, onDecompressing);

        return () => {
            controller.off(SocketEvent.UploadFileProgress, onProgress);
            controller.off(SocketEvent.UploadFileCompressing, onCompressing);
            controller.off(SocketEvent.UploadFileDecompressing, onDecompressing);
        };
    }, [isUploading]);

    const [uploadFileModalType, setUploadFileModalType] = useState<UploadFileModalType>(UploadFileModalType.None);

    useEffect(() => {
        if (fileUploadIsCompressing) {
            setUploadFileModalType(UploadFileModalType.Compressing);
        } else if (fileUploadIsDecompressing) {
            setUploadFileModalType(UploadFileModalType.Decompressing);
        } else if (fileUploadProgress > 0) {
            setUploadFileModalType(UploadFileModalType.Progress);
        } else {
            setUploadFileModalType(UploadFileModalType.None);
        }
    }, [fileUploadProgress, fileUploadIsCompressing, fileUploadIsDecompressing]);

    const dispatch = useDispatch();

    // The job's frame for a short press of the work switch. The server skips
    // the transfer when this connection already put the same bytes on the
    // controller (SacpUdpChannel). A failure is reported with the job's
    // result and never stops the job upload.
    const uploadBoundary = useCallback(async (): Promise<{ ok: boolean; text?: string }> => {
        if (!gcodeFile) {
            return { ok: false, text: 'no G-code loaded' };
        }

        log.info('Run Boundary... bbox =', gcodeFile.gcodeAxisWorkRange);

        const gcode = getRunBoundaryCode(gcodeFile.gcodeAxisWorkRange, jobOffsetMode, gcodeFile.is_rotate, setupCoordinateMethod);

        const blob = new Blob([gcode], { type: 'text/plain' });
        const file = new File([blob], 'boundary.nc');

        let gcodeFileObject: GCodeFileMetadata;
        try {
            gcodeFileObject = await dispatch(gcodeActions.uploadGcodeFile(file));
        } catch (err) {
            log.error('Unable to stage boundary G-code.', err);
            return { ok: false, text: String((err as Error)?.message || err) };
        }

        return new Promise((resolve) => {
            controller
                .emitEvent(SocketEvent.CompressUploadFile, {
                    filePath: gcodeFileObject.uploadName,
                    targetFilename: 'boundary.nc',
                })
                .once(SocketEvent.CompressUploadFile, ({ err, text }) => {
                    if (err) {
                        log.error('Unable to upload boundary G-code.');
                        log.error(err);
                        log.error(`Reason: ${text}`);
                        resolve({ ok: false, text });
                        return;
                    }

                    log.info('Uploaded boundary G-code.');
                    resolve({ ok: true });
                });
        });
    }, [dispatch, gcodeFile, jobOffsetMode, setupCoordinateMethod]);

    const uploadJob = useCallback(async (boundary: { ok: boolean; text?: string }) => {
        setIsUploading(true);

        return new Promise<boolean>((resolve) => {
            controller
                .emitEvent(SocketEvent.CompressUploadFile, {
                    filePath: gcodeFile.uploadName,
                    targetFilename: 'ray.nc',
                })
                .once(SocketEvent.CompressUploadFile, ({ err, text }) => {
                    setIsUploading(false);

                    setFileUploadProgress(0);
                    setFileUploadIsCompressing(false);
                    setFileUploadIsDecompressing(false);

                    // Deal with send result
                    if (err) {
                        log.error(err);
                        log.error(`Reason: ${text}`);
                        modalSmallHOC({
                            title: i18n._('key-Workspace/WifiTransport-Failed to send file.'),
                            text: text,
                            iconColor: '#FF4D4F',
                            img: 'WarningTipsError'
                        });
                        resolve(false);
                    } else {
                        const sent = i18n._('File sent successfully. Press and hold the work switch on the integrated controller (for about 3 seconds) until the machine starts the task.');
                        modalSmallHOC({
                            title: i18n._('key-Workspace/WifiTransport-File sent successfully.'),
                            text: boundary.ok
                                ? sent
                                : `${sent} ${i18n._('The job frame (boundary.nc) could not be updated: {{reason}}. A short press of the work switch runs the previous frame, not this job.', {
                                    reason: boundary.text || i18n._('unknown error'),
                                })}`,
                            iconColor: boundary.ok ? '#4CB518' : '#FFA940',
                            img: boundary.ok ? 'WarningTipsSuccess' : 'WarningTipsTips'
                        });
                        resolve(true);
                    }
                });
        });
    }, [gcodeFile]);

    const onClickUploadJob = useCallback(async () => {
        const boundary = await uploadBoundary();
        await uploadJob(boundary);
    }, [uploadBoundary, uploadJob]);

    return (
        <div className={classNames('border-radius-8', 'background-color-white', styles['output-wrapper'])}>
            <div className={classNames('position-re', 'margin-horizontal-16', 'margin-vertical-16')}>
                <Button
                    type="primary"
                    priority="level-one"
                    onClick={onClickUploadJob}
                    disabled={!isConnected || isWorking || !gcodeFile}
                >
                    {i18n._('key-Workspace/Upload Job')}
                </Button>
            </div>

            {
                isUploading && uploadFileModalType === UploadFileModalType.Compressing && (
                    <ModalSmallHOC
                        title={i18n._('key-Workspace/WifiTransport-Sending File')}
                        text={i18n._('Compressing file. Please wait…')}
                        iconColor="#4CB518"
                        img="WarningTipsProgress"
                        showCloseButton={false}
                    />
                )
            }
            {
                isUploading && uploadFileModalType === UploadFileModalType.Decompressing && (
                    <ModalSmallHOC
                        title={i18n._('key-Workspace/WifiTransport-Sending File')}
                        text={i18n._('Decompressing file. Please wait…')}
                        iconColor="#4CB518"
                        img="WarningTipsProgress"
                        showCloseButton={false}
                    />
                )
            }
            {
                isUploading && uploadFileModalType === UploadFileModalType.Progress && (
                    <ModalSmallHOC
                        title={i18n._('key-Workspace/WifiTransport-Sending File')}
                        text={i18n._('Sending file. Please wait… {{ progress }}%', {
                            progress: (fileUploadProgress * 100).toFixed(1),
                        })}
                        iconColor="#4CB518"
                        img="WarningTipsProgress"
                        showCloseButton={false}
                    />
                )
            }
        </div>
    );
};

export default UploadView;
