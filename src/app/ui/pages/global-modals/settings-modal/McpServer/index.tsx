import { Input, Switch } from 'antd';
import React, { useState, useEffect } from 'react';

import api from '../../../../../api';
import i18n from '../../../../../lib/i18n';
import UniApi from '../../../../../lib/uni-api';
import SvgIcon from '../../../../components/SvgIcon';
import styles from '../form.styl';

interface McpMqttSettings {
    values: {
        host: string;
        port: string;
        user: string;
        clientId: string;
        feedToolsetter: string;
        feedOvertravel: string;
        feedProbe: string;
        inverted: string;
    };
    passSet: boolean;
    envOverrides: string[];
    configured: boolean;
    missing: string[];
    defaultClientId: string;
}

interface McpStatus {
    running: boolean;
    port: number | null;
    toolCount: number;
    settings: {
        enabled: boolean;
        port: number;
        source: 'env' | 'config';
    };
    mqtt: McpMqttSettings;
}

const MQTT_FIELDS: Array<{ name: keyof McpMqttSettings['values']; labelKey: string; placeholder?: string; channel?: string }> = [
    { name: 'host', labelKey: 'key-App/Settings/McpServer-MQTT host', placeholder: 'io.adafruit.com' },
    { name: 'port', labelKey: 'key-App/Settings/McpServer-MQTT port', placeholder: '8883 (TLS)' },
    { name: 'user', labelKey: 'key-App/Settings/McpServer-MQTT username' },
    { name: 'clientId', labelKey: 'key-App/Settings/McpServer-MQTT client id' },
    { name: 'feedToolsetter', labelKey: 'key-App/Settings/McpServer-Tool setter feed', channel: 'toolsetter' },
    { name: 'feedOvertravel', labelKey: 'key-App/Settings/McpServer-Overtravel feed', channel: 'overtravel' },
    { name: 'feedProbe', labelKey: 'key-App/Settings/McpServer-CNC probe feed', channel: 'probe' },
];

const CHANNELS = ['toolsetter', 'overtravel', 'probe'];

/**
 * MCP server settings: enabled + port, persisted in the server configstore.
 * Changes apply at the next application start; the label reports what this
 * run is actually doing. The probe feed (MQTT) section configures the
 * external tool-setter / overtravel / touch-probe sensor transport -
 * environment variables LUBAN_MCP_MQTT_* override these fields.
 */
const McpServer: React.FC = () => {
    const [status, setStatus] = useState<McpStatus | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [port, setPort] = useState('');
    const [mqtt, setMqtt] = useState<{ [field: string]: string }>({});
    const [inverted, setInverted] = useState<{ [channel: string]: boolean }>({});
    const [mqttPass, setMqttPass] = useState('');
    const [mqttPassTouched, setMqttPassTouched] = useState(false);

    useEffect(() => {
        api.getMcpStatus()
            .then((res) => {
                const body: McpStatus = res.body;
                setStatus(body);
                setEnabled(body.settings.enabled);
                setPort(String(body.settings.port));
                const { inverted: invertedNames, ...values } = body.mqtt.values;
                setMqtt(values);
                const names = String(invertedNames || '').split(',').map((n) => n.trim().toLowerCase());
                const flags: { [channel: string]: boolean } = {};
                CHANNELS.forEach((channel) => {
                    flags[channel] = names.includes(channel);
                });
                setInverted(flags);
            })
            .catch(() => setStatus(null));
    }, []);

    const onSave = async () => {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            return;
        }
        const mqttUpdate: { [field: string]: string } = { ...mqtt };
        mqttUpdate.inverted = CHANNELS.filter((channel) => inverted[channel]).join(',');
        if (mqttPassTouched) {
            mqttUpdate.pass = mqttPass;
        }
        await api.setMcpSettings({ enabled, port: value, mqtt: mqttUpdate });
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

    const envOverrides = status ? status.mqtt.envOverrides : [];

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
            <div className="border-bottom-normal padding-bottom-4 margin-top-16">
                <span>{i18n._('key-App/Settings/McpServer-Probe sensor feed (MQTT)')}</span>
            </div>
            <div className="margin-top-8">
                <div className="margin-bottom-8">
                    {i18n._('key-App/Settings/McpServer-External tool setter, overtravel and touch probe sensors report over this feed. Feed fields accept an Adafruit IO feed key or a full topic path. Applies at the next feed connection.')}
                </div>
                {envOverrides.length > 0 && (
                    <div className="margin-bottom-8">
                        {i18n._('key-App/Settings/McpServer-Overridden by environment variables:')} {envOverrides.join(', ')}
                    </div>
                )}
                {MQTT_FIELDS.map((field) => {
                    let placeholder = field.placeholder || '';
                    if (field.name === 'clientId' && status) {
                        placeholder = status.mqtt.defaultClientId;
                    }
                    return (
                        <div className="sm-flex align-center margin-bottom-8" key={field.name}>
                            <span style={{ width: 160, flexShrink: 0 }}>{i18n._(field.labelKey)}</span>
                            <Input
                                value={mqtt[field.name] || ''}
                                placeholder={placeholder}
                                onChange={(e) => setMqtt({ ...mqtt, [field.name]: e.target.value })}
                                disabled={!enabled}
                            />
                            {field.channel && (
                                <>
                                    <Switch
                                        className="margin-left-8"
                                        size="small"
                                        checked={!!inverted[field.channel]}
                                        onChange={(checked) => setInverted({ ...inverted, [field.channel]: checked })}
                                        disabled={!enabled}
                                    />
                                    <span
                                        className="margin-left-4"
                                        style={{ whiteSpace: 'nowrap' }}
                                        title={i18n._('key-App/Settings/McpServer-Normally-open sensor: idles at 1, reads 0 on contact')}
                                    >
                                        {i18n._('key-App/Settings/McpServer-Inverted')}
                                    </span>
                                </>
                            )}
                        </div>
                    );
                })}
                <div className="sm-flex align-center margin-bottom-8">
                    <span style={{ width: 160, flexShrink: 0 }}>{i18n._('key-App/Settings/McpServer-MQTT password / key')}</span>
                    <Input.Password
                        value={mqttPass}
                        placeholder={status && status.mqtt.passSet
                            ? i18n._('key-App/Settings/McpServer-(saved - leave blank to keep)')
                            : ''}
                        onChange={(e) => {
                            setMqttPass(e.target.value);
                            setMqttPassTouched(true);
                        }}
                        disabled={!enabled}
                    />
                </div>
            </div>
        </div>
    );
};

export default McpServer;
