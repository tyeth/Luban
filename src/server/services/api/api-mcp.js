import config from '../configstore';
import { getMcpStatus } from '../mcp';

const ERR_BAD_REQUEST = 400;

export const getStatus = (req, res) => {
    res.send(getMcpStatus());
};

/**
 * Persist MCP settings (configstore). Applied at the next start; the
 * response carries live status so the UI can say so.
 */
export const updateSettings = (req, res) => {
    const { enabled, port } = req.body || {};

    if (port !== undefined) {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            res.status(ERR_BAD_REQUEST).send({ msg: `Invalid port: ${port}` });
            return;
        }
        config.set('mcpPort', value);
    }
    if (enabled !== undefined) {
        config.set('mcpEnabled', !!enabled);
    }

    res.send(getMcpStatus());
};
