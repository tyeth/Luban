/* eslint-disable */
import classNames from 'classnames';
import includes from 'lodash/includes';
import PropTypes from 'prop-types';
import React, { PureComponent } from 'react';
import { HEAD_PRINTING, METRIC_UNITS } from '../../../constants';
import i18n from '../../../lib/i18n';
import { Button } from '../../components/Buttons';
import Dropdown from '../../components/Dropdown';
import Menu from '../../components/Menu';
import SvgIcon from '../../components/SvgIcon';
import styles from './styles.styl';
import { planCoordinateGoto } from './coordinateGoto';

const OperationDropdown = (
    {
        menus,
        title,
        onClick,
        disabled
    }
) => {
    return <Dropdown
        overlay={(
            <Menu>
                {
                    menus.map((menu) => (
                        <Menu.Item
                            onClick={e => onClick(e, menu.isSetOrigin)}
                            key={menu.key}
                            disabled={disabled || menu.disabled}
                        >
                            <div className={classNames('align-c', 'padding-vertical-4')}>
                                {menu.title}
                            </div>
                        </Menu.Item>
                    ))
                }
            </Menu>
        )}
        placement="bottomLeft"
        trigger="click"
        disabled={disabled}
    >
        <Button>
            <div className={classNames(styles['operation-dropdown-icon'])}>
                {title}
                <SvgIcon
                    name="DropdownLine"
                    size={16}
                    type={['static']}
                />
            </div>
        </Button>
    </Dropdown>
};

class DisplayPanel extends PureComponent {
    static propTypes = {
        executeGcode: PropTypes.func.isRequired,
        workPosition: PropTypes.object.isRequired,
        headType: PropTypes.string,
        originOffset: PropTypes.object.isRequired,
        state: PropTypes.object,
        // Machine-frame travel a typed position must stay within (the Ray's work area), or null
        travel: PropTypes.object
    };

    // The coordinate being typed into: { axis, frame } or null
    state = {
        editing: null,
        draft: '',
        initial: '',
        error: ''
    };

    // Set when Enter or Escape has already closed the editor, so the blur
    // that follows does not commit a second time.
    skipBlur = false;

    componentDidUpdate() {
        // A job starting, a disconnect or a move in progress ends the edit unsent.
        if (this.state.editing && !(this.props.state && this.props.state.canClick)) {
            this.skipBlur = true;
            this.setState({ editing: null, error: '' });
        }
    }

    actions = {
        onClick: (event, isSetOrigin = false) => {
            const data = event.key;
            if (this.props.headType === HEAD_PRINTING) {
                if (isSetOrigin) return;
                else {
                    if (data) {
                        this.props.executeGcode(data);
                    }
                }
            } else {
                if (data) {
                    this.props.executeGcode(data);
                }
            }
        },
        beginEdit: (axis, frame, initial) => {
            if (!(this.props.state && this.props.state.canClick)) return;
            this.skipBlur = false;
            this.setState({ editing: { axis, frame }, draft: String(initial), initial: String(initial), error: '' });
        },
        changeDraft: (event) => {
            this.setState({ draft: event.target.value });
        },
        cancelEdit: () => {
            this.skipBlur = true;
            this.setState({ editing: null, error: '' });
        },
        // Enter keeps the editor open on a bad value; a blur closes it either way.
        commitEdit: (fromBlur) => {
            const { editing, draft, initial } = this.state;
            if (!editing) return;
            if (!(this.props.state && this.props.state.canClick)) {
                this.actions.cancelEdit();
                return;
            }
            const result = planCoordinateGoto({
                axis: editing.axis,
                frame: editing.frame,
                raw: draft,
                initial,
                originOffset: this.props.originOffset,
                isPrinting: this.props.headType === HEAD_PRINTING,
                jogSpeed: Number(this.props.state.jogSpeed),
                travel: this.props.travel
            });
            let error = '';
            if (result.kind === 'invalid') {
                error = i18n._('key-Workspace/Control/DisplayPanel-Not a number: {{value}}', { value: draft });
            } else if (result.kind === 'outside-travel') {
                error = i18n._('key-Workspace/Control/DisplayPanel-{{axis}} {{target}} mm is outside the machine travel ({{min}} to {{max}} mm), not moved', {
                    axis: editing.axis.toUpperCase(),
                    target: result.machineTarget,
                    min: result.min,
                    max: result.max
                });
            } else if (result.kind === 'move') {
                this.props.executeGcode(result.gcode);
            }
            if (error && !fromBlur) {
                this.setState({ error });
                return;
            }
            this.skipBlur = true;
            this.setState({ editing: null, error });
        },
        onEditKeyDown: (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.actions.commitEdit(false);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.actions.cancelEdit();
            }
        },
        onEditBlur: () => {
            if (this.skipBlur) {
                this.skipBlur = false;
                return;
            }
            this.actions.commitEdit(true);
        }
    };

    // A coordinate readout that turns into an input when clicked while the machine is idle.
    renderValue(axis, frame, initial, readout) {
        const { editing, draft } = this.state;
        const canClick = !!(this.props.state && this.props.state.canClick);
        if (editing && editing.axis === axis && editing.frame === frame) {
            return (
                <input
                    className={styles['coordinate-input']}
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={draft}
                    onChange={this.actions.changeDraft}
                    onFocus={e => e.target.select()}
                    onKeyDown={this.actions.onEditKeyDown}
                    onBlur={this.actions.onEditBlur}
                />
            );
        }
        if (!canClick) {
            return readout;
        }
        const title = frame === 'machine'
            ? i18n._('key-Workspace/Control/DisplayPanel-Click to type a machine position to go to')
            : i18n._('key-Workspace/Control/DisplayPanel-Click to type a work position to go to');
        return (
            <div
                className={styles['coordinate-editable']}
                role="button"
                tabIndex={0}
                title={title}
                onClick={() => this.actions.beginEdit(axis, frame, initial)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') this.actions.beginEdit(axis, frame, initial);
                }}
            >
                {readout}
            </div>
        );
    }

    render() {
        const { state, workPosition, originOffset, headType } = this.props;
        const { x, y, z, b } = originOffset;
        const { units, canClick, axes } = state;
        const lengthUnits = (units === METRIC_UNITS) ? i18n._('key-Workspace/Control/DisplayPanel-mm') : i18n._('key-Workspace/Control/DisplayPanel-in');
        let machinePositionX = (Math.round((parseFloat(workPosition.x) - x) * 1000) / 1000).toFixed(3);
        let machinePositionY = (Math.round((parseFloat(workPosition.y) - y) * 1000) / 1000).toFixed(3);
        let machinePositionZ = (Math.round((parseFloat(workPosition.z) - z) * 1000) / 1000).toFixed(3);
        let machinePositionB = (Math.round((parseFloat(workPosition.b) - b) * 1000) / 1000).toFixed(3);
        if (headType === HEAD_PRINTING) {
            machinePositionX = workPosition.x;
            machinePositionY = workPosition.y;
            machinePositionZ = workPosition.z;
        }
        return (
            <div className={classNames(styles['coordinate-panel'], 'margin-bottom-16')}>
                <table className="table table-bordered " style={{
                    borderCollapse: 'separate', borderRadius: '8px',
                    borderSpacing: 0
                }}>
                    <thead>
                        <tr>
                            <th>{i18n._('key-Workspace/Control/DisplayPanel-Axis')}</th>
                            <th>{i18n._('key-Workspace/Control/DisplayPanel-Machine Coordinates')}</th>
                            <th>{i18n._('key-Workspace/Control/DisplayPanel-Work Coordinates')}</th>
                            <th>{i18n._('key-Workspace/Control/DisplayPanel-Action')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {includes(axes, 'x') && (
                            <tr>
                                <td className={styles['field-axis']}>X</td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('x', 'machine', machinePositionX, (
                                        <div>
                                            <span className={styles['integer-part']}>{machinePositionX}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>{lengthUnits}</span>
                                </td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('x', 'work', workPosition.x, (
                                        <div>
                                            <span className={styles['integer-part']}>{workPosition.x.split('.')[0]}</span>
                                            <span className={styles['decimal-point']}>.</span>
                                            <span className={styles['fractional-part']}>{workPosition.x.split('.')[1]}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>{lengthUnits}</span>
                                </td>
                                <td className={styles.action}>
                                    <OperationDropdown
                                        onClick={this.actions.onClick}
                                        title={'X'}
                                        disabled={!canClick}
                                        menus={[
                                            { key: 'G0 X0', title: i18n._('key-Workspace/Control/DisplayPanel-Go To Work Zero On X Axis (G0 X0)') },
                                            {
                                                key: 'G92 X0',
                                                title: i18n._('key-Workspace/Control/DisplayPanel-Zero Out Temporary X Axis (G92 X0)'),
                                                isSetOrigin: true
                                            }
                                        ]} />
                                </td>
                            </tr>
                        )}
                        {includes(axes, 'y') && (
                            <tr>
                                <td className={styles['field-axis']}>Y</td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('y', 'machine', machinePositionY, (
                                        <div>
                                            <span className={styles['integer-part']}>{machinePositionY}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>{lengthUnits}</span>
                                </td>
                                <td className={styles['field-position']}>
                                    <span className={styles.unit}>{lengthUnits}</span>
                                    {this.renderValue('y', 'work', workPosition.y, (
                                        <div>
                                            <span className={styles['integer-part']}>{workPosition.y.split('.')[0]}</span>
                                            <span className={styles['decimal-point']}>.</span>
                                            <span className={styles['fractional-part']}>{workPosition.y.split('.')[1]}</span>
                                        </div>
                                    ))}
                                </td>
                                <td className={styles.action}>
                                    <OperationDropdown
                                        onClick={this.actions.onClick}
                                        title={'Y'}
                                        disabled={!canClick}
                                        menus={[
                                            { key: 'G0 Y0', title: i18n._('key-Workspace/Control/DisplayPanel-Go To Work Zero On Y Axis (G0 Y0)') },
                                            {
                                                key: 'G92 Y0',
                                                title: i18n._('key-Workspace/Control/DisplayPanel-Zero Out Temporary Y Axis (G92 Y0)'),
                                                isSetOrigin: true
                                            }
                                        ]} />
                                </td>
                            </tr>
                        )}
                        {includes(axes, 'z') && (
                            <tr>
                                <td className={styles['field-axis']}>Z</td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('z', 'machine', machinePositionZ, (
                                        <div>
                                            <span className={styles['integer-part']}>{machinePositionZ}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>{lengthUnits}</span>
                                </td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('z', 'work', workPosition.z, (
                                        <div>
                                            <span className={styles['integer-part']}>{workPosition.z.split('.')[0]}</span>
                                            <span className={styles['decimal-point']}>.</span>
                                            <span className={styles['fractional-part']}>{workPosition.z.split('.')[1]}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>{lengthUnits}</span>
                                </td>
                                <td className={styles.action}>
                                    <OperationDropdown
                                        onClick={this.actions.onClick}
                                        title={'Z'}
                                        disabled={!canClick}
                                        menus={[
                                            { key: 'G0 Z0', title: i18n._('key-Workspace/Control/DisplayPanel-Go To Work Zero On Z Axis (G0 Z0)') },
                                            {
                                                key: 'G92 Z0',
                                                title: i18n._('key-Workspace/Control/DisplayPanel-Zero Out Temporary Z Axis (G92 Z0)'),
                                                isSetOrigin: true
                                            }
                                        ]} />
                                </td>
                            </tr>
                        )}
                        {workPosition.isFourAxis && (
                            <tr>
                                <td className={styles['field-axis']}>B</td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('b', 'machine', machinePositionB, (
                                        <div>
                                            <span className={styles['integer-part']}>{machinePositionB}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>°</span>
                                </td>
                                <td className={styles['field-position']}>
                                    {this.renderValue('b', 'work', (workPosition.b || ''), (
                                        <div>
                                            <span className={styles['integer-part']}>{(workPosition.b || '').split('.')[0]}</span>
                                            <span className={styles['decimal-point']}>.</span>
                                            <span className={styles['fractional-part']}>{(workPosition.b || '').split('.')[1]}</span>
                                        </div>
                                    ))}
                                    <span className={styles.unit}>°</span>
                                </td>
                                <td className={styles.action}>
                                    <OperationDropdown
                                        onClick={this.actions.onClick}
                                        title={'B'}
                                        disabled={!canClick}
                                        menus={[
                                            { key: 'G0 B0', title: i18n._('key-Workspace/Control/DisplayPanel-Go To Work Zero On B Axis (G0 B0)') },
                                            {
                                                key: 'G92 B0',
                                                title: i18n._('key-Workspace/Control/DisplayPanel-Zero Out Temporary B Axis (G92 B0)'),
                                                isSetOrigin: true
                                            }
                                        ]} />
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
                {this.state.error && (
                    <div className={styles['coordinate-error']}>{this.state.error}</div>
                )}
            </div>
        );
    }
}

export default DisplayPanel;
