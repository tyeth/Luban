import { Input, Switch } from 'antd';
import React, { useState, useEffect } from 'react';

import api from '../../../../../api';
import i18n from '../../../../../lib/i18n';
import UniApi from '../../../../../lib/uni-api';
import SvgIcon from '../../../../components/SvgIcon';
import styles from '../form.styl';

interface McpStatus {
    running: boolean;
    port: number | null;
    toolCount: number;
    settings: {
        enabled: boolean;
        port: number;
        source: 'env' | 'config';
    };
}

/**
 * MCP server settings: enabled + port, persisted in the server configstore.
 * Changes apply at the next application start; the label reports what this
 * run is actually doing.
 */
const McpServer: React.FC = () => {
    const [status, setStatus] = useState<McpStatus | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [port, setPort] = useState('');

    useEffect(() => {
        api.getMcpStatus()
            .then((res) => {
                const body: McpStatus = res.body;
                setStatus(body);
                setEnabled(body.settings.enabled);
                setPort(String(body.settings.port));
            })
            .catch(() => setStatus(null));
    }, []);

    const onSave = async () => {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            return;
        }
        await api.setMcpSettings({ enabled, port: value });
    };

    useEffect(() => {
        UniApi.Event.on('appbar-menu:settings.save', onSave);
        return () => {
            UniApi.Event.off('appbar-menu:settings.save', onSave);
        };
    }, [onSave]);

    const handleChangePort = (e) => {
        const value = e.target.value;
        if (/^\d*$/.test(value)) {
            setPort(value);
        }
    };

    let statusLine = i18n._('key-App/Settings/McpServer-Status unknown');
    if (status) {
        statusLine = status.running
            ? `${i18n._('key-App/Settings/McpServer-Running this session at')} http://127.0.0.1:${status.port}/mcp (${status.toolCount} tools)`
            : i18n._('key-App/Settings/McpServer-Not running this session');
        if (status.settings.source === 'env') {
            statusLine += ` — ${i18n._('key-App/Settings/McpServer-Overridden by LUBAN_MCP_PORT')}`;
        }
    }

    return (
        <div className={styles['form-container']}>
            <div className="border-bottom-normal padding-bottom-4">
                <SvgIcon
                    name="TitleSetting"
                    type={['static']}
                />
                <span className="margin-left-4">{i18n._('key-App/Settings/McpServer-MCP Server')}</span>
            </div>
            <div className="margin-top-16">
                <div className="margin-bottom-8">{statusLine}</div>
                <div className="sm-flex align-center margin-bottom-8">
                    <Switch checked={enabled} onChange={(checked) => setEnabled(checked)} />
                    <span className="margin-left-8">{i18n._('key-App/Settings/McpServer-Enable MCP server (applies after restart)')}</span>
                </div>
                <div className={styles['set-port-box']}>
                    <Input
                        value={port}
                        onChange={handleChangePort}
                        disabled={!enabled}
                        className={styles['port-input']}
                    />
                    <div className={styles['port-tips']}>
                        {i18n._('key-App/Settings/McpServer-Local agents connect at')} http://127.0.0.1:&lt;port&gt;/mcp. {i18n._('key-App/Settings/McpServer-Loopback only; never reachable from the network')}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default McpServer;
